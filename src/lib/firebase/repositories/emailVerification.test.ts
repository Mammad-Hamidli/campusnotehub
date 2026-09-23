import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const ev = await import('./emailVerification');

async function user(id: string, email = `${id}@ada.edu.az`, emailVerifiedAt: Date | null = null) {
  await fake.db.collection('users').doc(id).set({ email, emailVerifiedAt, deletedAt: null });
}
const verifiedAt = (id: string) => fake.store.get(`users/${id}`)?.emailVerifiedAt;

beforeEach(() => fake.store.clear());
afterEach(() => vi.useRealTimers());

describe('email verification tokens', () => {
  it('verifies the account when redeemed by that account', async () => {
    await user('u1');
    const token = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    expect(await ev.redeemEmailVerification(token, 'u1')).toBe('verified');
    expect(verifiedAt('u1')).toBeInstanceOf(Date);
  });

  it('PRE-HIJACK: a link opened by anyone else verifies nothing, and stays usable by its owner', async () => {
    // The squatter's account; the link went to the real owner of the address.
    await user('squatter', 'victim@ada.edu.az');
    await user('victim-own-account', 'other@ada.edu.az');
    const token = await ev.issueEmailVerification('squatter', 'victim@ada.edu.az');

    expect(await ev.redeemEmailVerification(token, 'victim-own-account')).toBe('wrong_account');
    expect(verifiedAt('squatter')).toBeNull();
    // Not burned: a shared-computer mistake must not cost the owner the link.
    expect(await ev.redeemEmailVerification(token, 'squatter')).toBe('verified');
  });

  it('stores only a hash of the token', async () => {
    await user('u1');
    const token = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    const paths = [...fake.store.keys()].filter((p) => p.startsWith('emailVerifications/'));
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toContain(token);
    expect(JSON.stringify(fake.store.get(paths[0]))).not.toContain(token);
  });

  it('is single use', async () => {
    await user('u1');
    const token = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    await ev.redeemEmailVerification(token, 'u1');
    expect(await ev.redeemEmailVerification(token, 'u1')).toBe('invalid');
  });

  it('expires after 24 hours', async () => {
    await user('u1');
    vi.useFakeTimers();
    const token = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    vi.setSystemTime(Date.now() + ev.EMAIL_TOKEN_TTL_MS + 1);
    expect(await ev.redeemEmailVerification(token, 'u1')).toBe('invalid');
    expect(verifiedAt('u1')).toBeNull();
  });

  it('proves only the address it was sent to', async () => {
    await user('u1', 'old@ada.edu.az');
    const token = await ev.issueEmailVerification('u1', 'old@ada.edu.az');
    await fake.db.collection('users').doc('u1').update({ email: 'new@ada.edu.az' });
    expect(await ev.redeemEmailVerification(token, 'u1')).toBe('email_changed');
    expect(verifiedAt('u1')).toBeNull();
  });

  it('revokes the previous link when a new one is issued', async () => {
    await user('u1');
    const first = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    const second = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    expect(await ev.redeemEmailVerification(first, 'u1')).toBe('invalid');
    expect(await ev.redeemEmailVerification(second, 'u1')).toBe('verified');
  });

  it('reports an already-verified account without changing its date', async () => {
    const when = new Date('2026-01-01T00:00:00Z');
    await user('u1', 'u1@ada.edu.az', when);
    const token = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    expect(await ev.redeemEmailVerification(token, 'u1')).toBe('already_verified');
    expect(verifiedAt('u1')).toEqual(when);
  });

  it('rejects a malformed token without a read', async () => {
    expect(await ev.redeemEmailVerification('../users/u1', 'u1')).toBe('invalid');
  });
});

describe('POST /api/me/email/verify', () => {
  it('refuses a link opened with no session at all (a mail scanner, a stranger)', async () => {
    await user('u1');
    const token = await ev.issueEmailVerification('u1', 'u1@ada.edu.az');
    const { POST } = await import('@/app/api/me/email/verify/route');
    const res = await POST(
      new NextRequest('https://campushub.test/api/me/email/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    );
    expect(res.status).toBe(401);
    expect(verifiedAt('u1')).toBeNull();
  });
});
