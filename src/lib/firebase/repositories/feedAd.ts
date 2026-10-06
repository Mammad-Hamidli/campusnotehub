import type { DocumentData, Transaction } from 'firebase-admin/firestore';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { fromFirestore } from '../convert';

/**
 * The feed's ad slot: which mentor profiles staff promote there, and until when.
 *
 * One document, `siteConfig/feedAd` {mentorIds, expiresAt}, written only by
 * staff through /api/admin/feed-ad and by the expiry sweep. It stores profile
 * ids and nothing about the mentors, so a profile that is later unapproved,
 * paused or whose account is banned simply stops being shown (see
 * loadFeedAds) instead of lingering as a copy.
 *
 * `expiresAt` maps a mentor id to the end of its promotion. An id without one
 * was promoted before promotions had a duration and runs until removed.
 */

/** Promoted at once. Every public read loads all of them, so this stays small. */
export const FEED_AD_MAX_MENTORS = 10;

export type FeedAdEntry = {
  mentorId: string;
  /** null: no end date (promoted before durations existed). */
  expiresAt: Date | null;
};

const slot = () => adminDb().collection(COLLECTIONS.siteConfig).doc('feedAd');
const MENTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Still running at `now`. A promotion ends AT its expiry instant, not after it. */
export function isLiveEntry(entry: FeedAdEntry, now: Date): boolean {
  return entry.expiresAt === null || entry.expiresAt.getTime() > now.getTime();
}

/**
 * The stored entries, in promotion order. Also reads the two older shapes:
 * `{mentorIds}` without expiries, and the single `{mentorId}` from before
 * several mentors could be promoted. The next write replaces either.
 */
function entriesOf(raw: DocumentData | undefined): FeedAdEntry[] {
  const data = fromFirestore<DocumentData | undefined>(raw);
  const valid = (id: unknown): id is string => typeof id === 'string' && MENTOR_ID.test(id);
  const ids: string[] = Array.isArray(data?.mentorIds)
    ? [...new Set(data.mentorIds.filter(valid))]
    : valid(data?.mentorId)
      ? [data.mentorId]
      : [];
  const expiries = (data?.expiresAt ?? {}) as Record<string, unknown>;
  return ids.map((mentorId) => {
    const at = expiries[mentorId];
    return { mentorId, expiresAt: at instanceof Date && !Number.isNaN(at.getTime()) ? at : null };
  });
}

export async function getFeedAdEntries(): Promise<FeedAdEntry[]> {
  return entriesOf((await slot().get()).data());
}

/**
 * Read-modify-write of the entries in one transaction. `change` receives the
 * stored entries (live or lapsed) and returns the entries to store, or null
 * to store nothing. The caller adds its own writes - the mentors'
 * notifications - through `tx`, so they commit with exactly the change they
 * describe, or not at all.
 *
 * Firestore re-runs a transaction under contention, so `change` must have no
 * side effects beyond writes made through `tx`.
 */
export async function updateFeedAdEntries<T>(
  actorId: string,
  change: (current: FeedAdEntry[], tx: Transaction) => { entries: FeedAdEntry[] | null; result: T },
): Promise<T> {
  return adminDb().runTransaction(async (tx) => {
    const ref = slot();
    const { entries, result } = change(entriesOf((await tx.get(ref)).data()), tx);
    if (entries) {
      const expiresAt: Record<string, Date> = {};
      for (const entry of entries) if (entry.expiresAt) expiresAt[entry.mentorId] = entry.expiresAt;
      // set(), not a merge: it also drops the legacy single `mentorId` field
      // and the expiries of mentors no longer listed.
      tx.set(ref, {
        mentorIds: entries.map((entry) => entry.mentorId),
        expiresAt,
        updatedBy: actorId,
        updatedAt: new Date(),
      });
    }
    return result;
  });
}
