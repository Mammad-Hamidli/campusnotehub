import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const links = await import('./deviceLinks');

const live = () => true;
const issue = () => links.createDeviceLink({ userId: 'u1', sessionId: 's1', amr: ['qr', 'otp'], mfaAt: new Date() });

beforeEach(async () => {
  fake.store.clear();
  await fake.db.collection('sessions').doc('s1').set({ userId: 'u1', revokedAt: null });
});
afterEach(() => vi.useRealTimers());

describe('device links', () => {
  it('stores only the hash of the token, and the hash is the polling id', async () => {
    const { token, id } = await issue();
    const paths = [...fake.store.keys()];
    expect(paths).toContain(`deviceLinks/${id}`);
    expect(paths.join()).not.toContain(token);
  });

  it('signs in exactly once, with the factors fixed at issue time', async () => {
    const { token, id } = await issue();
    expect(await links.peekDeviceLink(token)).toBe('u1');

    const first = await links.redeemDeviceLink({ token, userAgent: 'Phone', issuerIsLive: live });
    expect(first).toMatchObject({ ok: true, userId: 'u1', amr: ['qr', 'otp'] });
    expect(await links.redeemDeviceLink({ token, userAgent: 'Phone', issuerIsLive: live })).toEqual({ ok: false, userId: 'u1' });

    expect(await links.peekDeviceLink(token)).toBeNull();
    expect(await links.getDeviceLinkStatus('u1', id)).toMatchObject({ state: 'linked', userAgent: 'Phone' });
  });

  it('refuses an expired code', async () => {
    const { token, id } = await issue();
    vi.useFakeTimers({ now: Date.now() + 2 * 60_000 + 1 });
    expect(await links.peekDeviceLink(token)).toBeNull();
    expect((await links.redeemDeviceLink({ token, userAgent: 'Phone', issuerIsLive: live })).ok).toBe(false);
    expect(await links.getDeviceLinkStatus('u1', id)).toEqual({ state: 'expired' });
  });

  it('dies with the session that issued it', async () => {
    const { token } = await issue();
    const result = await links.redeemDeviceLink({ token, userAgent: 'Phone', issuerIsLive: () => false });
    expect(result.ok).toBe(false);
    expect(await links.peekDeviceLink(token)).toBeNull();
  });

  it('can be withdrawn by its owner only, and only before it is used', async () => {
    const { token, id } = await issue();
    await links.cancelDeviceLink('someone-else', id);
    expect(await links.peekDeviceLink(token)).toBe('u1');
    expect(await links.getDeviceLinkStatus('someone-else', id)).toBeNull();

    await links.cancelDeviceLink('u1', id);
    expect(await links.peekDeviceLink(token)).toBeNull();
  });

  it.each(['', 'short', 'x'.repeat(43) + '!', '../sessions/s1'])('rejects a malformed token without a read: %j', async (token) => {
    expect(await links.redeemDeviceLink({ token, userAgent: 'Phone', issuerIsLive: live })).toEqual({ ok: false });
  });
});
