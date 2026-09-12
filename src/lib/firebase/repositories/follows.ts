import { adminDb } from '../admin.core';
import { SUBCOLLECTIONS } from '../collections';
import { forFirestore } from '../convert';

/**
 * The follow graph.
 *
 * Stored TWICE, as two subcollections: `users/{a}/following/{b}` and
 * `users/{b}/followers/{a}`. The SQL model was one `follows` row with indexes
 * in both directions; Firestore indexes only what a query can reach from a
 * single collection path, so answering "who do I follow" and "who follows me"
 * with keyed reads means writing both edges.
 *
 * Both are written in one batch, so the two directions cannot disagree. The
 * document id is the other party, which makes a duplicate follow
 * unrepresentable rather than merely prevented - the same trick the likes
 * subcollection uses.
 */

const following = (userId: string) => adminDb().collection(SUBCOLLECTIONS.userFollowing(userId));
const followers = (userId: string) => adminDb().collection(SUBCOLLECTIONS.userFollowers(userId));

/**
 * The accounts this viewer follows.
 *
 * Feeds this into the audience tokens (see src/lib/feed/audience.ts), so it is
 * read on every feed request. Only document IDS are needed, so the read is
 * limited to keys.
 *
 * The cap is deliberate and stated rather than silent: a viewer following more
 * than this many accounts gets FOLLOWERS-visibility posts from the first
 * `MAX_FOLLOWING_FOR_FEED` of them. Every other kind of post is unaffected,
 * because those tokens do not depend on the follow graph. At campus scale this
 * ceiling is far above any real account, and it bounds the query fan-out at
 * roughly 35 chunks rather than letting one pathological account issue
 * hundreds of queries per page.
 */
export const MAX_FOLLOWING_FOR_FEED = 1000;

export async function followingIds(userId: string): Promise<string[]> {
  const snap = await following(userId).select().limit(MAX_FOLLOWING_FOR_FEED).get();
  return snap.docs.map((doc) => doc.id);
}

export async function isFollowing(followerId: string, followeeId: string): Promise<boolean> {
  return (await following(followerId).doc(followeeId).get()).exists;
}

/** Writes both edges, or neither. */
export async function follow(followerId: string, followeeId: string): Promise<void> {
  // Self-follow is meaningless and would put a user in their own follower
  // count; refused here rather than at each call site.
  if (followerId === followeeId) return;

  const now = new Date();
  const batch = adminDb().batch();
  batch.set(following(followerId).doc(followeeId), forFirestore({ userId: followeeId, createdAt: now }));
  batch.set(followers(followeeId).doc(followerId), forFirestore({ userId: followerId, createdAt: now }));
  await batch.commit();
}

export async function unfollow(followerId: string, followeeId: string): Promise<void> {
  const batch = adminDb().batch();
  batch.delete(following(followerId).doc(followeeId));
  batch.delete(followers(followeeId).doc(followerId));
  await batch.commit();
}
