import type { Transaction } from 'firebase-admin/firestore';
import { NotificationType } from '@/lib/enums';
import { enqueueNotificationTx } from '@/lib/notifications/dispatch';
import { findMentorsByIds, type MentorProfileRecord } from '@/lib/firebase/repositories/mentors';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import {
  FEED_AD_MAX_MENTORS,
  getFeedAdMentorIds,
  updateFeedAdMentorIds,
} from '@/lib/firebase/repositories/feedAd';
import { isPubliclyVisible } from '@/lib/profile/visibility';
import { isPromotable } from './ad';

export type FeedAdUpdate =
  | {
      ok: true;
      /** The stored list before and after, in promotion order. */
      before: string[];
      featured: string[];
      /** Mentors whose status changed, each of whom was notified. */
      added: string[];
      removed: string[];
      /** Dropped because they stopped being eligible since being promoted. Not notified. */
      pruned: string[];
    }
  | { ok: false; reason: 'not_eligible'; ineligible: string[] }
  | { ok: false; reason: 'limit'; max: number };

const NOTICE = {
  featured: {
    type: NotificationType.MENTOR_FEATURED,
    titleKey: 'notifications.mentorFeatured.title',
    bodyKey: 'notifications.mentorFeatured.body',
  },
  unfeatured: {
    type: NotificationType.MENTOR_UNFEATURED,
    titleKey: 'notifications.mentorUnfeatured.title',
    bodyKey: 'notifications.mentorUnfeatured.body',
  },
} as const;

function notify(tx: Transaction, mentor: MentorProfileRecord, kind: keyof typeof NOTICE): void {
  enqueueNotificationTx(tx, { userId: mentor.userId, ...NOTICE[kind], linkUrl: `/mentors/${mentor.id}` });
}

/**
 * Promotes and removes several mentors in one atomic change, notifying each
 * mentor whose status actually changed - in the same commit, so nobody is
 * told about a change that did not happen.
 *
 * - Idempotent per mentor: promoting one already in the slot, or removing one
 *   who is not, changes nothing and notifies nobody.
 * - All or nothing: a promoted profile that is not eligible, or a list longer
 *   than FEED_AD_MAX_MENTORS, rejects the whole request and writes nothing.
 * - Profiles that stopped being eligible since they were promoted are dropped
 *   on the way (`pruned`), silently: the suspension or unapproval that caused
 *   it is the news, not the ad.
 *
 * Every profile involved, and its owner, is read up front in two batched
 * reads, however many mentors are selected; the transaction itself re-reads
 * only the list.
 */
export async function updateFeedAds(params: {
  promote: string[];
  demote: string[];
  actorId: string;
}): Promise<FeedAdUpdate> {
  const promote = [...new Set(params.promote)];
  const demote = new Set(params.demote);

  const stored = await getFeedAdMentorIds();
  const looked = new Set([...stored, ...promote, ...demote]);
  const mentors = await findMentorsByIds([...looked]);
  const owners = await findUsersByIds([...mentors.values()].map((m) => m.userId));
  const ownerOf = (id: string) => {
    const mentor = mentors.get(id);
    return mentor ? owners.get(mentor.userId) : undefined;
  };
  const eligible = (id: string) => isPromotable(mentors.get(id), ownerOf(id));

  const ineligible = promote.filter((id) => !eligible(id));
  if (ineligible.length > 0) return { ok: false, reason: 'not_eligible', ineligible };

  return updateFeedAdMentorIds<FeedAdUpdate>(params.actorId, (current, tx) => {
    const has = new Set(current);
    const removed = current.filter((id) => demote.has(id));
    // Only ids judged above: one promoted by someone else since that read is
    // kept as it is rather than judged blind.
    const pruned = current.filter((id) => !demote.has(id) && looked.has(id) && !eligible(id));
    const added = promote.filter((id) => !has.has(id));

    const gone = new Set([...removed, ...pruned]);
    const featured = [...current.filter((id) => !gone.has(id)), ...added];

    if (featured.length > FEED_AD_MAX_MENTORS) {
      return { mentorIds: null, result: { ok: false, reason: 'limit', max: FEED_AD_MAX_MENTORS } };
    }
    if (added.length === 0 && gone.size === 0) {
      return { mentorIds: null, result: { ok: true, before: current, featured: current, added, removed, pruned } };
    }

    for (const id of added) notify(tx, mentors.get(id)!, 'featured');
    // A removed mentor whose account is gone or frozen has nobody to tell.
    for (const id of removed) {
      const mentor = mentors.get(id);
      if (mentor && isPubliclyVisible(ownerOf(id))) notify(tx, mentor, 'unfeatured');
    }
    return { mentorIds: featured, result: { ok: true, before: current, featured, added, removed, pruned } };
  });
}
