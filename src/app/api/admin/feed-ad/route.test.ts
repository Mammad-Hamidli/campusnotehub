import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const adminAudit = vi.fn(async () => {});
vi.mock('@/lib/auth/admin', () => ({
  // The staff check itself is covered elsewhere; here every caller is staff.
  withAdmin: (_request: unknown, _tier: unknown, handler: (actor: { id: string }) => unknown) => handler({ id: 'staff1' }),
  adminAudit: (...args: unknown[]) => adminAudit(...(args as [])),
}));

const { PUT } = await import('./route');
const { loadFeedAd } = await import('@/lib/feed/ad');

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://localhost/api/admin/feed-ad', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;

async function mentor(id: string, userId: string, isApproved = true, accountStatus = 'ACTIVE') {
  await fake.db.collection('users').doc(userId).set({
    nickname: `nick_${userId}`,
    accountStatus,
    deletedAt: null,
    isVerified: true,
    avatarUrl: '/api/media/avatar1',
    universityId: null,
  });
  await fake.db.collection('mentorProfiles').doc(id).set({
    userId,
    isApproved,
    headline: 'Senior engineer',
    industry: 'IT',
    jobTitle: 'Engineer',
    company: 'Acme',
    ratingAvg: 4.5,
    ratingCount: 2,
    sessionsCompleted: 7,
    hourlyRateMinor: 2500,
  });
}

const slot = () => fake.store.get('siteConfig/feedAd');

beforeEach(() => {
  fake.store.clear();
  adminAudit.mockClear();
});

describe('PUT /api/admin/feed-ad', () => {
  it('promotes an approved mentor in one call, audited, and the feed shows it', async () => {
    await mentor('m1', 'u1');

    const response = await put({ mentorId: 'm1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ current: 'm1' });
    expect(slot()).toMatchObject({ mentorId: 'm1', updatedBy: 'staff1' });
    expect(adminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ADMIN_FEED_AD_SET', before: { mentorId: null }, after: { mentorId: 'm1' } }),
    );

    expect(await loadFeedAd()).toMatchObject({
      mentorId: 'm1',
      nickname: 'nick_u1',
      avatarUrl: '/api/media/avatar1',
      industry: 'IT',
      hourlyRateMinor: 2500,
    });
  });

  it('replaces the current mentor, and null empties the slot', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await put({ mentorId: 'm1' });

    await put({ mentorId: 'm2' });
    expect(slot()).toMatchObject({ mentorId: 'm2' });

    const cleared = await put({ mentorId: null });
    expect(cleared.status).toBe(200);
    expect(slot()).toMatchObject({ mentorId: null });
    expect(adminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'ADMIN_FEED_AD_CLEARED', before: { mentorId: 'm2' } }),
    );
    expect(await loadFeedAd()).toBeNull();
  });

  it('refuses an unapproved profile, a suspended account and an unknown id', async () => {
    await mentor('pending', 'u1', false);
    await mentor('frozen', 'u2', true, 'SUSPENDED');

    for (const mentorId of ['pending', 'frozen', 'missing']) {
      const response = await put({ mentorId });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'admin.feedAd.errors.notEligible' });
    }
    expect(slot()).toBeUndefined();
    expect(adminAudit).not.toHaveBeenCalled();
  });

  it('rejects a malformed id', async () => {
    expect((await put({ mentorId: '../users/x' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });
});

describe('loadFeedAd', () => {
  it('drops a promoted mentor whose account was suspended or profile unapproved since', async () => {
    await mentor('m1', 'u1');
    await put({ mentorId: 'm1' });

    await fake.db.collection('users').doc('u1').set({ nickname: 'nick_u1', accountStatus: 'SUSPENDED', deletedAt: null });
    expect(await loadFeedAd()).toBeNull();

    await mentor('m1', 'u1', false);
    expect(await loadFeedAd()).toBeNull();
  });
});
