import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const sendEmail = vi.fn(async () => ({ ok: true as const, id: null }));
vi.mock('@/lib/email/send', () => ({ sendEmail }));
vi.mock('@/lib/firebase/repositories/audit', () => ({ writeAuditLog: async () => {} }));
const budget = { ok: true };
vi.mock('@/lib/security/ratelimit', () => ({ rateLimit: async () => ({ ...budget, remaining: 0, retryAfterSeconds: 0 }) }));

const { requestPasswordReset } = await import('./password-reset');
const ctx = { ip: '203.0.113.7' };

async function account(id: string, passwordHash: string | null, accountStatus = 'ACTIVE') {
  await fake.db
    .collection('users')
    .doc(id)
    .set({ email: `${id}@ada.edu.az`, nickname: id, accountStatus, deletedAt: null });
  await fake.db.collection('credentials').doc(id).set({ passwordHash });
}

beforeEach(() => {
  fake.store.clear();
  sendEmail.mockClear();
  budget.ok = true;
});

describe('requestPasswordReset', () => {
  it('emails a fragment link to an account with a password', async () => {
    await account('u1', '$argon2id$x');
    expect(await requestPasswordReset('U1@ada.edu.az', ctx)).toBe('sent');
    expect(sendEmail).toHaveBeenCalledOnce();
    const [to, template, params] = sendEmail.mock.calls[0] as unknown as [string, string, { url: string; minutes: number }];
    expect(to).toBe('u1@ada.edu.az');
    expect(template).toBe('passwordResetLink');
    expect(params.url).toMatch(/\/reset-password#token=[A-Za-z0-9_-]{43}$/);
    expect(params.minutes).toBe(30);
  });

  it('sends nothing for an unknown address', async () => {
    expect(await requestPasswordReset('nobody@ada.edu.az', ctx)).toBe('no_account');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never bolts a password onto a Google-only account', async () => {
    await account('g1', null);
    expect(await requestPasswordReset('g1@ada.edu.az', ctx)).toBe('no_password');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing to a banned account', async () => {
    await account('b1', '$argon2id$x', 'BANNED');
    expect(await requestPasswordReset('b1@ada.edu.az', ctx)).toBe('no_account');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('stops silently at the per-account limit', async () => {
    await account('u1', '$argon2id$x');
    budget.ok = false;
    expect(await requestPasswordReset('u1@ada.edu.az', ctx)).toBe('throttled');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
