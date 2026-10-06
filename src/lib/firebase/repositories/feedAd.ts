import type { DocumentData, Transaction } from 'firebase-admin/firestore';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';

/**
 * The feed's ad slot: which mentor profiles staff promote there.
 *
 * One document, `siteConfig/feedAd` {mentorIds}, written only by staff through
 * /api/admin/feed-ad. It stores profile ids and nothing about the mentors, so
 * a profile that is later unapproved, paused or whose account is banned
 * simply stops being shown (see loadFeedAds) instead of lingering as a copy.
 */

/** Promoted at once. Every public read loads all of them, so this stays small. */
export const FEED_AD_MAX_MENTORS = 10;

const slot = () => adminDb().collection(COLLECTIONS.siteConfig).doc('feedAd');
const MENTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The stored ids, in promotion order. Also reads the single `{mentorId}` shape
 * the document had before several mentors could be promoted, so a promotion
 * made before the deploy survives it; the next write replaces that shape.
 */
function mentorIdsOf(data: DocumentData | undefined): string[] {
  const valid = (id: unknown): id is string => typeof id === 'string' && MENTOR_ID.test(id);
  if (Array.isArray(data?.mentorIds)) return [...new Set(data.mentorIds.filter(valid))];
  return valid(data?.mentorId) ? [data.mentorId] : [];
}

export async function getFeedAdMentorIds(): Promise<string[]> {
  return mentorIdsOf((await slot().get()).data());
}

/**
 * Read-modify-write of the list in one transaction. `change` receives the
 * stored ids and returns the list to store, or null to store nothing. The
 * caller adds its own writes - the mentors' notifications - through `tx`, so
 * they commit with exactly the change they describe, or not at all.
 *
 * Firestore re-runs a transaction under contention, so `change` must have no
 * side effects beyond writes made through `tx`.
 */
export async function updateFeedAdMentorIds<T>(
  actorId: string,
  change: (current: string[], tx: Transaction) => { mentorIds: string[] | null; result: T },
): Promise<T> {
  return adminDb().runTransaction(async (tx) => {
    const ref = slot();
    const { mentorIds, result } = change(mentorIdsOf((await tx.get(ref)).data()), tx);
    // set(), not a merge: it also drops the legacy single `mentorId` field.
    if (mentorIds) tx.set(ref, { mentorIds, updatedBy: actorId, updatedAt: new Date() });
    return result;
  });
}
