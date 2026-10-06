import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { GET, PATCH } = await import('./route');
const { loadFeedAds } = await import('@/lib/feed/ad');
const { sweepExpiredFeedAds } = await import('@/lib/feed/ad-admin');
const { GET: publicGET } = await import('@/app/api/feed/ad/route');

const NOW = new Date('2026-10-06T12:00:00Z');
const IN_A_WEEK = '2026-10-13T12:00:00.000Z';
const DAY = 86_400_000;
const later = (ms: number) => vi.setSystemTime(new Date(NOW.getTime() + ms));

const patch = (body: unknown) =>
  PATCH(
    new NextRequest('http://localhost/api/admin/feed-ad', {
      method: 'PATCH',
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
    isAcceptingBookings: true,
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

const suspend = (userId: string) =>
  fake.db.collection('users').doc(userId).set({ nickname: `nick_${userId}`, accountStatus: 'SUSPENDED', deletedAt: null });

const slot = () => fake.store.get('siteConfig/feedAd');
const store = (collection: string) =>
  [...fake.store.entries()].filter(([path]) => path.startsWith(`${collection}/`)).map(([, doc]) => doc);
const notifications = () =>
  [...fake.store.entries()].filter(([path]) => path.startsWith('notifications/')).map(([, doc]) => doc);
const notified = (type: string) =>
  notifications()
    .filter((n) => n.type === type)
    .map((n) => n.userId)
    .sort();

beforeEach(() => {
  fake.store.clear();
  adminAudit.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PATCH /api/admin/feed-ad', () => {
  it('promotes several mentors in one call: one write, one audit row, one notification each', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await mentor('m3', 'u3');

    const response = await patch({ promote: ['m1', 'm2', 'm3'], duration: '1w' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      featured: ['m1', 'm2', 'm3'],
      expiries: { m1: IN_A_WEEK, m2: IN_A_WEEK, m3: IN_A_WEEK },
      added: ['m1', 'm2', 'm3'],
      removed: [],
      renewed: [],
    });
    expect(slot()).toMatchObject({ mentorIds: ['m1', 'm2', 'm3'], updatedBy: 'staff1' });
    expect(slot()?.expiresAt).toEqual({ m1: new Date(IN_A_WEEK), m2: new Date(IN_A_WEEK), m3: new Date(IN_A_WEEK) });

    expect(notifications()).toHaveLength(3);
    expect(notifications()[0]).toMatchObject({
      type: 'MENTOR_FEATURED',
      titleKey: 'notifications.mentorFeatured.title',
      bodyKey: 'notifications.mentorFeatured.bodyUntil',
      linkUrl: '/mentors/m1',
      params: { when: IN_A_WEEK },
      readAt: null,
    });
    expect(notified('MENTOR_FEATURED')).toEqual(['u1', 'u2', 'u3']);

    expect(adminAudit).toHaveBeenCalledTimes(1);
    expect(adminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ADMIN_FEED_AD_UPDATED',
        before: { mentorIds: [], expiresAt: {} },
        after: expect.objectContaining({
          mentorIds: ['m1', 'm2', 'm3'],
          duration: '1w',
          added: ['m1', 'm2', 'm3'],
          removed: [],
          renewed: [],
          pruned: [],
          expired: [],
        }),
      }),
    );

    const ads = await loadFeedAds();
    expect(ads.map((ad) => ad.mentorId)).toEqual(['m1', 'm2', 'm3']);
    expect(ads[0]).toMatchObject({ nickname: 'nick_u1', avatarUrl: '/api/media/avatar1', industry: 'IT', hourlyRateMinor: 2500 });
  });

  it('removes and promotes in the same request, notifying only the mentors whose status changed', async () => {
    for (const n of [1, 2, 3, 4]) await mentor(`m${n}`, `u${n}`);
    await patch({ promote: ['m1', 'm2', 'm3'], duration: '1w' });
    fake.store.forEach((_, path) => path.startsWith('notifications/') && fake.store.delete(path));

    const response = await patch({ promote: ['m2', 'm4'], demote: ['m1', 'm3'], duration: '1w' });
    expect(await response.json()).toMatchObject({ featured: ['m2', 'm4'], added: ['m4'], removed: ['m1', 'm3'], renewed: ['m2'] });
    expect(slot()).toMatchObject({ mentorIds: ['m2', 'm4'] });
    expect(notified('MENTOR_FEATURED')).toEqual(['u4']);
    expect(notified('MENTOR_UNFEATURED')).toEqual(['u1', 'u3']);
  });

  it('is idempotent: removing a mentor who is not in the slot writes and notifies nothing', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await patch({ promote: ['m1'], duration: '1w' });
    const stored = slot();
    adminAudit.mockClear();

    const response = await patch({ demote: ['m2'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ featured: ['m1'], expiries: { m1: IN_A_WEEK }, added: [], removed: [], renewed: [] });
    expect(slot()).toEqual(stored);
    expect(notifications()).toHaveLength(1);
    expect(adminAudit).not.toHaveBeenCalled();
  });

  it('renews a mentor already in the slot from now, without notifying them again', async () => {
    await mentor('m1', 'u1');
    await patch({ promote: ['m1'], duration: '1d' });
    later(12 * 3600_000);

    const response = await patch({ promote: ['m1'], duration: '1m' });
    expect(await response.json()).toEqual({
      featured: ['m1'],
      expiries: { m1: '2026-11-07T00:00:00.000Z' },
      added: [],
      removed: [],
      renewed: ['m1'],
    });
    expect(notifications()).toHaveLength(1);
    expect(adminAudit).toHaveBeenLastCalledWith(expect.objectContaining({ after: expect.objectContaining({ renewed: ['m1'] }) }));
  });

  it('refuses to promote without a duration, or with one it does not offer', async () => {
    await mentor('m1', 'u1');
    expect((await patch({ promote: ['m1'] })).status).toBe(400);
    expect((await patch({ promote: ['m1'], duration: '1y' })).status).toBe(400);
    // Removing needs none.
    expect((await patch({ demote: ['m1'] })).status).toBe(200);
    expect(slot()).toBeUndefined();
  });

  it('rejects the whole request when any promoted profile is not eligible', async () => {
    await mentor('m1', 'u1');
    await mentor('pending', 'u2', false);
    await mentor('frozen', 'u3', true, 'SUSPENDED');

    const response = await patch({ promote: ['m1', 'pending', 'frozen', 'missing'], duration: '1w' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'admin.feedAd.errors.notEligible',
      ineligible: ['pending', 'frozen', 'missing'],
    });
    expect(slot()).toBeUndefined();
    expect(notifications()).toHaveLength(0);
    expect(adminAudit).not.toHaveBeenCalled();
  });

  it('enforces the cap without writing anything', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `m${i}`);
    for (const id of ids) await mentor(id, `u_${id}`);

    const tooMany = await patch({ promote: ids, duration: '1w' });
    expect(tooMany.status).toBe(409);
    expect(await tooMany.json()).toEqual({ error: 'admin.feedAd.errors.limit', max: 10 });
    expect(slot()).toBeUndefined();

    expect((await patch({ promote: ids.slice(0, 10), duration: '1w' })).status).toBe(200);
    expect((await patch({ promote: [ids[10]], duration: '1w' })).status).toBe(409);
    expect(slot()?.mentorIds).toEqual(ids.slice(0, 10));
    expect(notifications()).toHaveLength(10);

    // Swapping one out for one in fits, in a single request.
    expect((await patch({ promote: [ids[10]], demote: [ids[0]], duration: '1w' })).status).toBe(200);
    expect(slot()?.mentorIds).toEqual([...ids.slice(1, 10), ids[10]]);
  });

  it('drops a promoted mentor who stopped being eligible, without notifying them', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await mentor('m3', 'u3');
    await patch({ promote: ['m1', 'm2'], duration: '1w' });
    await suspend('u1');

    const response = await patch({ promote: ['m3'], duration: '1w' });
    expect(await response.json()).toMatchObject({ featured: ['m2', 'm3'], added: ['m3'], removed: [] });
    expect(adminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ mentorIds: ['m2', 'm3'], added: ['m3'], pruned: ['m1'] }) }),
    );
    expect(notified('MENTOR_UNFEATURED')).toEqual([]);
  });

  it('reads the older document shapes as promotions without an end, and replaces them on write', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    fake.store.set('siteConfig/feedAd', { mentorId: 'm1', updatedBy: 'staff0', updatedAt: new Date() });
    expect((await loadFeedAds()).map((ad) => ad.mentorId)).toEqual(['m1']);

    await patch({ promote: ['m2'], duration: '1w' });
    expect(slot()).toEqual({
      mentorIds: ['m1', 'm2'],
      expiresAt: { m2: new Date(IN_A_WEEK) },
      updatedBy: 'staff1',
      updatedAt: expect.any(Date),
    });

    // Without an end date, nothing sweeps it: it stays until removed.
    later(400 * DAY);
    expect(await sweepExpiredFeedAds()).toEqual(['m2']);
    expect((await loadFeedAds()).map((ad) => ad.mentorId)).toEqual(['m1']);
  });

  it('rejects malformed bodies', async () => {
    for (const body of [
      null,
      {},
      { promote: [] },
      { promote: 'm1' },
      { promote: ['../users/x'] },
      { promote: ['m1'], demote: ['m1'] },
      { demote: Array.from({ length: 51 }, (_, i) => `m${i}`) },
    ]) {
      expect((await patch(body)).status).toBe(400);
    }
  });
});

describe('GET /api/admin/feed-ad', () => {
  it('lists promotable mentors, and only the featured ids that are still promotable', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await mentor('pending', 'u3', false);
    await patch({ promote: ['m1', 'm2'], duration: '1w' });
    await suspend('u2');

    const response = await GET(new NextRequest('http://localhost/api/admin/feed-ad'));
    const body = await response.json();
    expect(body.featured).toEqual(['m1']);
    expect(body.expiries).toEqual({ m1: IN_A_WEEK });
    expect(body.max).toBe(10);
    expect(body.mentors.map((m: { id: string }) => m.id)).toEqual(['m1']);
    expect(body.mentors[0]).toMatchObject({ nickname: 'nick_u1', avatarUrl: '/api/media/avatar1', isAcceptingBookings: true });
  });
});

describe('loadFeedAds', () => {
  it('drops promoted mentors whose account was suspended or profile unapproved since', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await patch({ promote: ['m1', 'm2'], duration: '1w' });

    await suspend('u1');
    expect((await loadFeedAds()).map((ad) => ad.mentorId)).toEqual(['m2']);

    await mentor('m2', 'u2', false);
    expect(await loadFeedAds()).toEqual([]);
  });
});

/** Who was told their promotion ran out. */
const ended = () =>
  notifications()
    .filter((n) => n.titleKey === 'notifications.mentorPromotionEnded.title')
    .map((n) => n.userId)
    .sort();

describe('promotion durations', () => {
  it('hides a lapsed ad at its end, before any sweep, and never caches past it', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await patch({ promote: ['m1'], duration: '1d' });
    await patch({ promote: ['m2'], duration: '1w' });

    later(DAY - 20_000);
    let response = await publicGET();
    expect((await response.json()).ads.map((ad: { mentorId: string }) => ad.mentorId)).toEqual(['m1', 'm2']);
    // 20 s left on m1: the CDN may keep this for at most that, and serve nothing stale.
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=20');

    later(DAY);
    expect((await loadFeedAds()).map((ad) => ad.mentorId)).toEqual(['m2']);
    expect(slot()?.mentorIds).toEqual(['m1', 'm2']);

    // The first public read that sees it sweeps it, and the mentor is told once.
    response = await publicGET();
    expect((await response.json()).ads.map((ad: { mentorId: string }) => ad.mentorId)).toEqual(['m2']);
    expect(slot()?.mentorIds).toEqual(['m2']);
    expect(slot()?.expiresAt).toEqual({ m2: new Date(NOW.getTime() + 7 * DAY) });
    expect(ended()).toEqual(['u1']);
    expect(await sweepExpiredFeedAds()).toEqual([]);
    expect(ended()).toEqual(['u1']);
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=30, stale-while-revalidate=60');
  });

  it('sweeps from the scheduler, notifying only mentors whose account is still visible', async () => {
    await mentor('m1', 'u1');
    await mentor('m2', 'u2');
    await mentor('m3', 'u3');
    await patch({ promote: ['m1', 'm2'], duration: '1d' });
    await patch({ promote: ['m3'], duration: '1m' });
    await suspend('u2');

    later(2 * DAY);
    expect(await sweepExpiredFeedAds()).toEqual(['m1', 'm2']);
    expect(slot()?.mentorIds).toEqual(['m3']);
    expect(ended()).toEqual(['u1']);
    expect(store('auditLogs')).toEqual([
      expect.objectContaining({ action: 'FEED_AD_EXPIRED', actorId: null, after: { expired: ['m1', 'm2'] } }),
    ]);
  });

  it('does not count lapsed promotions towards the cap, and ends them on the next change', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    for (const id of ids) await mentor(id, `u_${id}`);
    await mentor('fresh', 'u_fresh');
    await patch({ promote: ids, duration: '1d' });
    expect((await patch({ promote: ['fresh'], duration: '1w' })).status).toBe(409);

    later(DAY);
    const response = await patch({ promote: ['fresh', 'm0'], duration: '1w' });
    expect(response.status).toBe(200);
    // m0 lapsed and was promoted again: a fresh promotion, not "ended" + "featured".
    expect(await response.json()).toMatchObject({ featured: ['fresh', 'm0'], added: ['fresh', 'm0'], renewed: [] });
    expect(ended()).toEqual(ids.slice(1).map((id) => `u_${id}`).sort());

    const admin = await (await GET(new NextRequest('http://localhost/api/admin/feed-ad'))).json();
    expect(admin.featured).toEqual(['fresh', 'm0']);
  });
});

describe('feedAdExpiry', () => {
  it('counts a month as the same day next month, clamped to its end', async () => {
    const { feedAdExpiry } = await import('@/lib/feed/ad-duration');
    expect(feedAdExpiry('1d', new Date('2026-10-06T12:00:00Z')).toISOString()).toBe('2026-10-07T12:00:00.000Z');
    expect(feedAdExpiry('1w', new Date('2026-12-29T08:30:00Z')).toISOString()).toBe('2027-01-05T08:30:00.000Z');
    expect(feedAdExpiry('1m', new Date('2026-01-31T09:15:00Z')).toISOString()).toBe('2026-02-28T09:15:00.000Z');
    expect(feedAdExpiry('1m', new Date('2028-01-31T09:15:00Z')).toISOString()).toBe('2028-02-29T09:15:00.000Z');
    expect(feedAdExpiry('1m', new Date('2026-12-15T23:59:00Z')).toISOString()).toBe('2027-01-15T23:59:00.000Z');
  });
});
