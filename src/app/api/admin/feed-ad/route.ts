import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { findMentorsByIds, listMentors } from '@/lib/firebase/repositories/mentors';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { FEED_AD_MAX_MENTORS, getFeedAdMentorIds } from '@/lib/firebase/repositories/feedAd';
import { isPromotable } from '@/lib/feed/ad';
import { updateFeedAds } from '@/lib/feed/ad-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Plenty for a hand-picked promotion list; the directory scan has its own ceiling. */
const CANDIDATE_LIMIT = 200;
/** Ids per list in one PATCH: bounds the two batched reads a request can cause. */
const BULK_LIMIT = 50;

/**
 * GET /api/admin/feed-ad - the promoted mentor ids and every mentor that
 * could be promoted: approved profiles whose account is publicly visible.
 *
 * MODERATOR tier, like mentor applications: the people who approve mentors
 * decide which ones are featured.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const [stored, { mentors: recent }] = await Promise.all([
      getFeedAdMentorIds(),
      listMentors({}, 'recent', 0, CANDIDATE_LIMIT),
    ]);
    // A promoted profile is always listed, even past the newest
    // CANDIDATE_LIMIT, or the panel could never remove it.
    const listed = recent.slice(0, CANDIDATE_LIMIT);
    const listedIds = new Set(listed.map((m) => m.id));
    const older = await findMentorsByIds(stored.filter((id) => !listedIds.has(id)));
    const profiles = [...listed, ...older.values()];
    const owners = await findUsersByIds(profiles.map((m) => m.userId));

    const candidates = profiles.flatMap((m) => {
      const user = owners.get(m.userId);
      if (!user || !isPromotable(m, user)) return [];
      return [{
        id: m.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl ?? null,
        isVerified: user.isVerified,
        headline: m.headline,
        industry: m.industry,
        isAcceptingBookings: m.isAcceptingBookings,
      }];
    });
    // Ineligible ids still stored are invisible to the feed and pruned on the next change.
    const eligibleIds = new Set(candidates.map((c) => c.id));

    return NextResponse.json(
      { featured: stored.filter((id) => eligibleIds.has(id)), max: FEED_AD_MAX_MENTORS, mentors: candidates },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}

const mentorIds = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(BULK_LIMIT);
const patchSchema = z
  .object({ promote: mentorIds.default([]), demote: mentorIds.default([]) })
  .refine((body) => body.promote.length + body.demote.length > 0)
  .refine((body) => !body.promote.some((id) => body.demote.includes(id)));

/**
 * PATCH /api/admin/feed-ad { promote?: id[], demote?: id[] } - add and remove
 * any number of mentors in one atomic change; each mentor whose status changed
 * gets an in-app notification in the same commit (see updateFeedAds).
 *
 * 409 with `ineligible` when a promoted profile cannot be promoted, or with
 * `max` when the result would exceed the cap. Nothing is written either way.
 */
export async function PATCH(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    }

    const outcome = await updateFeedAds({ ...parsed.data, actorId: actor.id });
    if (!outcome.ok) {
      return outcome.reason === 'limit'
        ? NextResponse.json({ error: 'admin.feedAd.errors.limit', max: outcome.max }, { status: 409 })
        : NextResponse.json(
            { error: 'admin.feedAd.errors.notEligible', ineligible: outcome.ineligible },
            { status: 409 },
          );
    }

    const { before, featured, added, removed, pruned } = outcome;
    if (added.length + removed.length + pruned.length > 0) {
      await adminAudit({
        actorId: actor.id,
        action: 'ADMIN_FEED_AD_UPDATED',
        entityType: 'siteConfig',
        entityId: 'feedAd',
        before: { mentorIds: before },
        after: { mentorIds: featured, added, removed, pruned },
        request,
      });
    }

    return NextResponse.json({ featured, added, removed }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
