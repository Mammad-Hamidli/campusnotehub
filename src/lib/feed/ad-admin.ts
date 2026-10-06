import type { Transaction } from 'firebase-admin/firestore';
import { NotificationType } from '@/lib/enums';
import { enqueueNotificationTx } from '@/lib/notifications/dispatch';
import { findMentorsByIds, type MentorProfileRecord } from '@/lib/firebase/repositories/mentors';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import {
  FEED_AD_MAX_MENTORS,
  getFeedAdEntries,
  isLiveEntry,
  updateFeedAdEntries,
  type FeedAdEntry,
} from '@/lib/firebase/repositories/feedAd';
import { isPubliclyVisible } from '@/lib/profile/visibility';
import { feedAdExpiry, type FeedAdDuration } from './ad-duration';
import { isPromotable } from './ad';

export type FeedAdUpdate =
  | {
      ok: true;
      /** The stored entries before and after, in promotion order. */
      before: FeedAdEntry[];
      entries: FeedAdEntry[];
      /** Mentors whose status changed, each of whom was notified. */
      added: string[];
      removed: string[];
      /** Already promoted, given a new end date. Not notified: nothing they see changed. */
      renewed: string[];
      /** Dropped because they stopped being eligible since being promoted. Not notified. */
      pruned: string[];
      /** Dropped because their duration ran out before the sweep got to them. Told it ended. */
      expired: string[];
    }
  | { ok: false; reason: 'not_eligible'; ineligible: string[] }
  | { ok: false; reason: 'limit'; max: number };

const NOTICE = {
  featured: {
    type: NotificationType.MENTOR_FEATURED,
    titleKey: 'notifications.mentorFeatured.title',
    // Not `.body`: rows written before durations existed carry that key with
    // no `when` to fill in, and must keep rendering.
    bodyKey: 'notifications.mentorFeatured.bodyUntil',
  },
  unfeatured: {
    type: NotificationType.MENTOR_UNFEATURED,
    titleKey: 'notifications.mentorUnfeatured.title',
    bodyKey: 'notifications.mentorUnfeatured.body',
  },
  ended: {
    type: NotificationType.MENTOR_UNFEATURED,
    titleKey: 'notifications.mentorPromotionEnded.title',
    bodyKey: 'notifications.mentorPromotionEnded.body',
  },
} as const;

function notify(
  tx: Transaction,
  mentor: MentorProfileRecord,
  kind: keyof typeof NOTICE,
  params?: Record<string, string>,
): void {
  enqueueNotificationTx(tx, { userId: mentor.userId, ...NOTICE[kind], params, linkUrl: `/mentors/${mentor.id}` });
}

/** Every profile involved, and its owner, in two batched reads. */
async function loadProfiles(ids: Iterable<string>) {
  const mentors = await findMentorsByIds([...new Set(ids)]);
  const owners = await findUsersByIds([...mentors.values()].map((m) => m.userId));
  const ownerOf = (id: string) => {
    const mentor = mentors.get(id);
    return mentor ? owners.get(mentor.userId) : undefined;
  };
  return { mentors, ownerOf, eligible: (id: string) => isPromotable(mentors.get(id), ownerOf(id)) };
}

/**
 * Promotes, renews and removes several mentors in one atomic change, notifying
 * each mentor whose status actually changed - in the same commit, so nobody
 * is told about a change that did not happen.
 *
 * - `duration` sets when the promoted mentors' ads end. Promoting a mentor who
 *   is already in the slot RENEWS them: the new end date counts from now.
 *   Renewing notifies nobody - nothing the mentor sees changes.
 * - Idempotent per removal: removing a mentor who is not in the slot changes
 *   nothing and notifies nobody.
 * - All or nothing: a promoted profile that is not eligible, or a list longer
 *   than FEED_AD_MAX_MENTORS, rejects the whole request and writes nothing.
 *   Lapsed promotions do not count towards the cap.
 * - Profiles that stopped being eligible since they were promoted are dropped
 *   on the way (`pruned`), silently: the suspension or unapproval that caused
 *   it is the news, not the ad. Promotions whose time ran out are dropped too
 *   (`expired`), and their mentors are told, as the sweep would have.
 *
 * Every profile involved, and its owner, is read up front in two batched
 * reads, however many mentors are selected; the transaction itself re-reads
 * only the list.
 */
export async function updateFeedAds(params: {
  promote: string[];
  demote: string[];
  /** Required whenever `promote` is not empty; the route enforces it. */
  duration: FeedAdDuration | null;
  actorId: string;
  now?: Date;
}): Promise<FeedAdUpdate> {
  const now = params.now ?? new Date();
  const promote = [...new Set(params.promote)];
  const demote = new Set(params.demote);
  if (promote.length > 0 && !params.duration) throw new Error('updateFeedAds: promoting needs a duration');
  const expiresAt = params.duration ? feedAdExpiry(params.duration, now) : null;

  const stored = await getFeedAdEntries();
  const looked = new Set([...stored.map((entry) => entry.mentorId), ...promote, ...demote]);
  const { mentors, ownerOf, eligible } = await loadProfiles(looked);

  const ineligible = promote.filter((id) => !eligible(id));
  if (ineligible.length > 0) return { ok: false, reason: 'not_eligible', ineligible };

  return updateFeedAdEntries<FeedAdUpdate>(params.actorId, (current, tx) => {
    const live = current.filter((entry) => isLiveEntry(entry, now));
    const liveIds = new Set(live.map((entry) => entry.mentorId));
    const promoting = new Set(promote);

    const removed = live.filter((entry) => demote.has(entry.mentorId)).map((entry) => entry.mentorId);
    // Only ids judged above: one promoted by someone else since that read is
    // kept as it is rather than judged blind.
    const pruned = live
      .filter(({ mentorId: id }) => !demote.has(id) && looked.has(id) && !eligible(id))
      .map((entry) => entry.mentorId);
    // A lapsed mentor promoted again is simply promoted - not also told it ended.
    const expired = current
      .filter((entry) => !isLiveEntry(entry, now) && !promoting.has(entry.mentorId))
      .map((entry) => entry.mentorId);
    const renewed = promote.filter((id) => liveIds.has(id));
    const added = promote.filter((id) => !liveIds.has(id));

    const gone = new Set([...removed, ...pruned]);
    const entries: FeedAdEntry[] = [
      ...live
        .filter((entry) => !gone.has(entry.mentorId))
        .map((entry) => (promoting.has(entry.mentorId) ? { mentorId: entry.mentorId, expiresAt } : entry)),
      ...added.map((mentorId) => ({ mentorId, expiresAt })),
    ];

    if (entries.length > FEED_AD_MAX_MENTORS) {
      return { entries: null, result: { ok: false, reason: 'limit', max: FEED_AD_MAX_MENTORS } };
    }
    const result = { ok: true as const, before: current, entries, added, removed, renewed, pruned, expired };
    if (added.length + gone.size + renewed.length + expired.length === 0) {
      return { entries: null, result: { ...result, entries: current } };
    }

    const until = expiresAt ? { when: expiresAt.toISOString() } : undefined;
    for (const id of added) notify(tx, mentors.get(id)!, 'featured', until);
    // A mentor whose account is gone or frozen has nobody to tell.
    const visible = (id: string) => mentors.has(id) && isPubliclyVisible(ownerOf(id));
    for (const id of removed) if (visible(id)) notify(tx, mentors.get(id)!, 'unfeatured');
    for (const id of expired) if (visible(id)) notify(tx, mentors.get(id)!, 'ended');
    return { entries, result };
  });
}

/**
 * Takes every promotion whose time has run out off the stored list, and tells
 * each of those mentors it ended - in the same commit, so a mentor is told
 * exactly once even when two sweeps race. Returns the mentor ids removed.
 *
 * Correctness does not wait for this: the public read path (loadFeedAdSlot)
 * already hides a lapsed ad at its end. This tidies the list, frees the slot
 * for the admin panel's cap and sends the notice. It runs from the scheduler
 * (every minute), the scheduled-tasks cron, and from GET /api/feed/ad the
 * first time that route sees a lapsed entry.
 *
 * Costs one document read when nothing has lapsed, which is nearly always.
 */
export async function sweepExpiredFeedAds(now = new Date()): Promise<string[]> {
  const stored = await getFeedAdEntries();
  const lapsed = stored.filter((entry) => !isLiveEntry(entry, now)).map((entry) => entry.mentorId);
  if (lapsed.length === 0) return [];
  const { mentors, ownerOf } = await loadProfiles(lapsed);

  const removed = await updateFeedAdEntries<string[]>('system', (current, tx) => {
    const ended = current.filter((entry) => !isLiveEntry(entry, now));
    if (ended.length === 0) return { entries: null, result: [] };
    for (const { mentorId } of ended) {
      const mentor = mentors.get(mentorId);
      if (mentor && isPubliclyVisible(ownerOf(mentorId))) notify(tx, mentor, 'ended');
    }
    return {
      entries: current.filter((entry) => isLiveEntry(entry, now)),
      result: ended.map((entry) => entry.mentorId),
    };
  });

  if (removed.length > 0) {
    // After the commit, and best effort: the change itself is already safe.
    await writeAuditLog({
      actorId: null,
      action: 'FEED_AD_EXPIRED',
      entityType: 'siteConfig',
      entityId: 'feedAd',
      after: { expired: removed },
    }).catch((error) => console.error('[feed-ad] expiry audit failed', error));
  }
  return removed;
}
