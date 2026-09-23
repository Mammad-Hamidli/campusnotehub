import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const pr = await import('./passwordResets');

async function account(id: string, opts: { email?: string; passwordHash?: string | null; status?: string } = {}) {
  const email = opts.email ?? `${id}@ada.edu.az`;
  await fake.db.collection('users').doc(id).set({
    email,
    accountStatus: opts.status ?? 'ACTIVE',
    deletedAt: null,
    failedLoginCount: 7,
    lockedUntil: new Date(Date.now() + 60_000),
  });
  await fake.db.collection('credentials').doc(id).set({ passwordHash: opts.passwordHash === undefined ? '$argon2id$old' : opts.passwordHash });
  return { userId: id, email, passwordHash: '$argon2id$old' };
}
const hashOf = (id: string) => fake.store.get(`credentials/${id}`)?.passwordHash;
const liveTokens = () => [...fake.store.keys()].filter((p) => p.startsWith('passwordResets/'));

beforeEach(() => fake.store.clear());
afterEach(() => vi.useRealTimers());

describe('password reset tokens', () => {
  it('installs the new hash and clears the lockout', async () => {
    const token = await pr.issuePasswordReset(await account('u1'));
    expect(await pr.isPasswordResetLive(token)).toBe(true);
    expect(await pr.redeemPasswordReset(token, '$argon2id$new')).toEqual({ ok: true, userId: 'u1' });
    expect(hashOf('u1')).toBe('$argon2id$new');
    expect(fake.store.get('users/u1')?.failedLoginCount).toBe(0);
    expect(fake.store.get('users/u1')?.lockedUntil).toBeNull();
  });

  it('stores only a hash of the token', async () => {
    const token = await pr.issuePasswordReset(await account('u1'));
    expect(liveTokens()).toHaveLength(1);
    expect(liveTokens()[0]).not.toContain(token);
    expect(JSON.stringify(fake.store.get(liveTokens()[0]))).not.toContain(token);
    // Nor the password hash it is bound to.
    expect(JSON.stringify(fake.store.get(liveTokens()[0]))).not.toContain('$argon2id$old');
  });

  it('is single use', async () => {
    const token = await pr.issuePasswordReset(await account('u1'));
    await pr.redeemPasswordReset(token, '$argon2id$new');
    expect(await pr.isPasswordResetLive(token)).toBe(false);
    expect(await pr.redeemPasswordReset(token, '$argon2id$attacker')).toEqual({ ok: false });
    expect(hashOf('u1')).toBe('$argon2id$new');
  });

  it('expires after 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const token = await pr.issuePasswordReset(await account('u1'));
    vi.setSystemTime(Date.now() + pr.PASSWORD_RESET_TTL_MS + 1);
    expect(await pr.isPasswordResetLive(token)).toBe(false);
    expect(await pr.redeemPasswordReset(token, '$argon2id$new')).toEqual({ ok: false });
    expect(hashOf('u1')).toBe('$argon2id$old');
    expect(liveTokens()).toHaveLength(0);
  });

  it('keeps only the newest link alive', async () => {
    const acct = await account('u1');
    const first = await pr.issuePasswordReset(acct);
    const second = await pr.issuePasswordReset(acct);
    expect(await pr.redeemPasswordReset(first, '$argon2id$x')).toEqual({ ok: false });
    expect(await pr.redeemPasswordReset(second, '$argon2id$new')).toEqual({ ok: true, userId: 'u1' });
  });

  it('dies when the password changes by any other route', async () => {
    const token = await pr.issuePasswordReset(await account('u1'));
    await fake.db.collection('credentials').doc('u1').update({ passwordHash: '$argon2id$changed-in-settings' });
    expect(await pr.redeemPasswordReset(token, '$argon2id$new')).toEqual({ ok: false });
    expect(hashOf('u1')).toBe('$argon2id$changed-in-settings');
  });

  it('dies when the account email changes', async () => {
    const token = await pr.issuePasswordReset(await account('u1'));
    await fake.db.collection('users').doc('u1').update({ email: 'new@ada.edu.az' });
    expect(await pr.redeemPasswordReset(token, '$argon2id$new')).toEqual({ ok: false });
  });

  it('refuses banned and deleted accounts', async () => {
    const banned = await pr.issuePasswordReset(await account('b1', { status: 'BANNED' }));
    expect(await pr.redeemPasswordReset(banned, '$argon2id$new')).toEqual({ ok: false });
    const acct = await account('d1');
    const deleted = await pr.issuePasswordReset(acct);
    await fake.db.collection('users').doc('d1').update({ deletedAt: new Date() });
    expect(await pr.redeemPasswordReset(deleted, '$argon2id$new')).toEqual({ ok: false });
  });

  it('rejects malformed tokens without a lookup', async () => {
    expect(await pr.isPasswordResetLive('')).toBe(false);
    expect(await pr.isPasswordResetLive('../users/u1')).toBe(false);
    expect(await pr.redeemPasswordReset('x'.repeat(44), '$argon2id$new')).toEqual({ ok: false });
  });

  it('revokePasswordResets removes every outstanding link', async () => {
    const token = await pr.issuePasswordReset(await account('u1'));
    await pr.revokePasswordResets('u1');
    expect(liveTokens()).toHaveLength(0);
    expect(await pr.redeemPasswordReset(token, '$argon2id$new')).toEqual({ ok: false });
  });
});
