import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { findMentorsByIds, listMentors } from '@/lib/firebase/repositories/mentors';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { FEED_AD_MAX_MENTORS, getFeedAdEntries, isLiveEntry, type FeedAdEntry } from '@/lib/firebase/repositories/feedAd';
import { isPromotable } from '@/lib/feed/ad';
import { updateFeedAds } from '@/lib/feed/ad-admin';
import { FEED_AD_DURATIONS } from '@/lib/feed/ad-duration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Plenty for a hand-picked promotion list; the directory scan has its own ceiling. */
const CANDIDATE_LIMIT = 200;
/** Ids per list in one PATCH: bounds the two batched reads a request can cause. */
const BULK_LIMIT = 50;

/** Each listed mentor's end date as ISO, or null for a promotion without one. */
function expiriesOf(entries: FeedAdEntry[]): Record<string, string | null> {
  return Object.fromEntries(entries.map((entry) => [entry.mentorId, entry.expiresAt?.toISOString() ?? null]));
}

/**
 * GET /api/admin/feed-ad - the promoted mentor ids with their end dates, and
 * every mentor that could be promoted: approved profiles whose account is
 * publicly visible. A promotion whose time ran out is not listed as featured,
 * even before the sweep has removed it.
 *
 * MODERATOR tier, like mentor applications: the people who approve mentors
 * decide which ones are featured.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const now = new Date();
    const [entries, { mentors: recent }] = await Promise.all([
      getFeedAdEntries(),
      listMentors({}, 'recent', 0, CANDIDATE_LIMIT),
    ]);
    const live = entries.filter((entry) => isLiveEntry(entry, now));
    const stored = live.map((entry) => entry.mentorId);
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

    const featured = live.filter((entry) => eligibleIds.has(entry.mentorId));
    return NextResponse.json(
      {
        featured: featured.map((entry) => entry.mentorId),
        expiries: expiriesOf(featured),
        max: FEED_AD_MAX_MENTORS,
        mentors: candidates,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}

const mentorIds = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(BULK_LIMIT);
const patchSchema = z
  .object({
    promote: mentorIds.default([]),
    demote: mentorIds.default([]),
    duration: z.enum(FEED_AD_DURATIONS).optional(),
  })
  .refine((body) => body.promote.length + body.demote.length > 0)
  .refine((body) => !body.promote.some((id) => body.demote.includes(id)))
  // Every promotion has an end: there is no "forever" to fall back on.
  .refine((body) => body.promote.length === 0 || body.duration !== undefined);

/**
 * PATCH /api/admin/feed-ad { promote?: id[], demote?: id[], duration? }
 * - add, renew and remove any number of mentors in one atomic change.
 * `duration` ('1d' | '1w' | '1m') is required with `promote`: it sets when
 * those ads end, counted from now - so promoting a mentor already in the slot
 * renews them. Each mentor whose status changed gets an in-app notification
 * in the same commit (see updateFeedAds).
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

    const { promote, demote, duration } = parsed.data;
    const outcome = await updateFeedAds({ promote, demote, duration: duration ?? null, actorId: actor.id });
    if (!outcome.ok) {
      return outcome.reason === 'limit'
        ? NextResponse.json({ error: 'admin.feedAd.errors.limit', max: outcome.max }, { status: 409 })
        : NextResponse.json(
            { error: 'admin.feedAd.errors.notEligible', ineligible: outcome.ineligible },
            { status: 409 },
          );
    }

    const { before, entries, added, removed, renewed, pruned, expired } = outcome;
    const featured = entries.map((entry) => entry.mentorId);
    if (added.length + removed.length + renewed.length + pruned.length + expired.length > 0) {
      await adminAudit({
        actorId: actor.id,
        action: 'ADMIN_FEED_AD_UPDATED',
        entityType: 'siteConfig',
        entityId: 'feedAd',
        before: { mentorIds: before.map((entry) => entry.mentorId), expiresAt: expiriesOf(before) },
        after: { mentorIds: featured, expiresAt: expiriesOf(entries), duration, added, removed, renewed, pruned, expired },
        request,
      });
    }

    return NextResponse.json(
      { featured, expiries: expiriesOf(entries), added, removed, renewed },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
