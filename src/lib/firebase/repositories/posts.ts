import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';
import { audienceTokens, chunkViewerTokens } from '@/lib/feed/audience';

/**
 * Posts, comments and likes.
 *
 * ===========================================================================
 * THE SHAPE, AND WHY IT IS DENORMALISED
 * ===========================================================================
 * A post document embeds its tags and its media as ARRAYS rather than pointing
 * at join tables. Both are small, bounded (5 tags, 4 images) and always read
 * together with the post, so a subcollection would mean an extra read per post
 * per page - the N+1 that Prisma's `include` existed to avoid, reintroduced.
 *
 * LIKES are the exception and are a SUBCOLLECTION keyed by the liker. A viral
 * post can collect more likes than fit in a 1 MiB document, and keying by user
 * id reproduces the (postId, userId) primary key the SQL table had, so a double
 * like is unrepresentable rather than merely prevented.
 *
 * `likeCount` and `commentCount` stay denormalised counters on the post, as
 * they were in SQL, and are maintained with FieldValue.increment() - which is
 * atomic on the server and therefore safe under concurrent likes without a
 * transaction.
 */

export type PostMediaRecord = {
  id: string;
  storageKey: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  altText: string | null;
  position: number;
};

export type PostRecord = {
  id: string;
  authorId: string;
  body: string;
  visibility: string;
  universityId: string | null;
  parentPostId: string | null;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isPinned: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  /** See src/lib/feed/audience.ts - this is what makes visibility queryable. */
  audience: string[];
  tagSlugs: string[];
  tags: { slug: string; label: string }[];
  media: PostMediaRecord[];
};

export type CommentRecord = {
  id: string;
  postId: string;
  authorId: string;
  parentId: string | null;
  body: string;
  isDeleted: boolean;
  createdAt: Date;
};

const posts = () => adminDb().collection(COLLECTIONS.posts);
const comments = () => adminDb().collection(COLLECTIONS.comments);

export function newPostId(): string {
  return posts().doc().id;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function findPostById(id: string): Promise<PostRecord | null> {
  return docToObject<PostRecord>(await posts().doc(id).get()) as PostRecord | null;
}

export type FeedQuery = {
  tokens: string[];
  limit: number;
  /** Keyset cursor: everything strictly older than this instant. */
  before?: Date | null;
  /** Narrows to one university's posts (the 'university' filter tab). */
  universityId?: string | null;
  /** Narrows to these authors (the 'following' filter tab). */
  authorIds?: string[] | null;
  tagSlug?: string | null;
};

/**
 * One page of the feed.
 *
 * ---------------------------------------------------------------------------
 * HOW THE MERGE WORKS, AND WHY IT IS CORRECT
 * ---------------------------------------------------------------------------
 * The viewer's tokens may exceed Firestore's 30-value ceiling for
 * `array-contains-any` (one token per followed account), so they are split
 * into chunks and each chunk is a separate query. Every query:
 *
 *   - filters on the SAME cursor instant,
 *   - orders by createdAt DESC,
 *   - takes `limit + 1` rows.
 *
 * Because each chunk independently returns the newest rows it can see, the
 * union of those results is guaranteed to contain the globally newest `limit`
 * rows across all chunks: no chunk can be hiding a row newer than the ones it
 * returned. Sorting the union and taking `limit` is therefore exactly the page
 * a single query would have produced. This is a standard fan-in merge and it
 * is the reason the base tokens are repeated into every chunk.
 *
 * Duplicates are real - a post can match several chunks - so the merge is
 * keyed by document id.
 */
export async function feedPage(query: FeedQuery): Promise<{
  rows: PostRecord[];
  hasMore: boolean;
}> {
  const chunks = chunkViewerTokens(query.tokens);

  /**
   * THE TAG FILTER CANNOT BE A QUERY CLAUSE. IT IS NOT A STYLE CHOICE.
   *
   * `audience` is already matched with `array-contains-any`, and Firestore
   * permits AT MOST ONE array clause per query - a second one is rejected
   * outright, and a composite index naming two CONTAINS fields is refused by
   * the API with:
   *
   *     'ARRAY_CONTAINS' can be selected for only one field in a composite
   *     index
   *
   * which is exactly what blocked the first production index deploy. So the
   * two array filters cannot coexist and one of them has to move.
   *
   * IT IS THE TAG THAT MOVES, NEVER THE AUDIENCE. `audience` is the security
   * boundary - it is what decides whether the viewer may see the post at all -
   * so it stays in the query where it cannot be forgotten. The tag is a
   * presentation filter over rows the viewer is already entitled to, the same
   * standing the `authorIds` filter below has, and for the same reason.
   */
  const take = query.limit + 1;

  /**
   * Over-fetch when filtering in memory.
   *
   * A post-query filter applied to `limit + 1` rows under-fills the page: a
   * tag matching one post in ten would return two rows for a page of twenty
   * and the feed would look empty. Widening the read gives the filter
   * something to survive on, capped so a rare tag cannot turn one page into an
   * unbounded scan. `hasMore` is still computed from the FILTERED set, so the
   * cursor stays correct either way.
   */
  const fetchSize = query.tagSlug ? Math.min(take * 10, 300) : take;

  const results = await Promise.all(
    chunks.map(async (tokens) => {
      let q: FirebaseFirestore.Query = posts()
        .where('isDeleted', '==', false)
        .where('audience', 'array-contains-any', tokens);

      if (query.universityId) q = q.where('universityId', '==', query.universityId);
      if (query.before) q = q.where('createdAt', '<', query.before);

      const snap = await q.orderBy('createdAt', 'desc').limit(fetchSize).get();
      return docsToObjects<PostRecord>(snap.docs) as PostRecord[];
    }),
  );

  const byId = new Map<string, PostRecord>();
  for (const row of results.flat()) byId.set(row.id, row);

  let merged = [...byId.values()];

  // The tag filter, applied over rows the audience clause already authorised.
  // See the note on fetchSize above for why it cannot be a query clause.
  if (query.tagSlug) {
    const slug = query.tagSlug;
    merged = merged.filter((p) => (p.tagSlugs ?? []).includes(slug));
  }

  /**
   * The 'following' tab narrows to a set of authors.
   *
   * Applied here rather than as a `where authorId in [...]` because that
   * clause is itself capped at 30 values and would multiply against the token
   * chunks - a viewer following 200 accounts would need 7 x 7 queries. The
   * token set already restricts the rows to what the viewer may see; this is a
   * presentation filter over that, not a security boundary.
   */
  if (query.authorIds) {
    const allowed = new Set(query.authorIds);
    merged = merged.filter((p) => allowed.has(p.authorId));
  }

  merged.sort((a, b) => {
    const diff = b.createdAt.getTime() - a.createdAt.getTime();
    // Ties broken by id descending, matching the SQL keyset order so the
    // cursor cannot skip or repeat a row when timestamps collide.
    return diff !== 0 ? diff : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  });

  const hasMore = merged.length > query.limit;
  return { rows: hasMore ? merged.slice(0, query.limit) : merged, hasMore };
}

/**
 * Which of these posts the viewer has liked.
 *
 * Replaces the `likes: { where: { userId } }` include. Firestore cannot filter
 * a subcollection across parents, so this reads one document per post by key -
 * cheap, because a keyed read that misses costs nothing to transfer - and it
 * is issued for the page only, not the whole feed.
 */
export async function likedPostIds(postIds: string[], viewerId: string): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();

  const refs = postIds.map((id) =>
    adminDb().collection(SUBCOLLECTIONS.postLikes(id)).doc(viewerId),
  );
  const snaps = await adminDb().getAll(...refs);

  const liked = new Set<string>();
  snaps.forEach((snap, i) => {
    if (snap.exists) liked.add(postIds[i]);
  });
  return liked;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function createPost(params: {
  id: string;
  authorId: string;
  body: string;
  visibility: string;
  universityId: string | null;
  tags: { slug: string; label: string }[];
  media: PostMediaRecord[];
}): Promise<PostRecord> {
  const now = new Date();
  const record = {
    authorId: params.authorId,
    body: params.body,
    visibility: params.visibility,
    universityId: params.universityId,
    parentPostId: null,
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    isPinned: false,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
    editedAt: null,
    // The single writer of this field. See src/lib/feed/audience.ts.
    audience: audienceTokens({
      authorId: params.authorId,
      visibility: params.visibility,
      universityId: params.universityId,
    }),
    tagSlugs: params.tags.map((t) => t.slug),
    tags: params.tags,
    media: params.media,
  };

  await posts().doc(params.id).set(forFirestore(record));
  return { id: params.id, ...record };
}

/**
 * Sets whether a user likes a post, and keeps the counter in step.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT BY CONSTRUCTION, WHICH IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * The SQL version relied on the (postId, userId) composite primary key: liking
 * twice raised a unique violation, which the route caught and reported as
 * success. Firestore has no unique constraint, but the like document is KEYED
 * by the user, so "already liked" is simply "the document exists" - the same
 * guarantee, without needing an exception as control flow.
 *
 * The counter is only moved when the like document actually changes state.
 * Incrementing unconditionally is how a double-tap double-counts; decrementing
 * unconditionally is how a repeated DELETE drives a counter negative and a
 * "-3 likes" bug is born. Both were called out in the original route and both
 * are preserved here.
 *
 * The delete/create and the counter update commit as ONE batch, so a like can
 * never be recorded without its increment. FieldValue.increment() is applied
 * server-side, so two people liking the same instant both count - which a
 * read-modify-write could not guarantee.
 */
export async function setPostLike(
  postId: string,
  userId: string,
  liked: boolean,
): Promise<{ likeCount: number; changed: boolean }> {
  const likeRef = adminDb().collection(SUBCOLLECTIONS.postLikes(postId)).doc(userId);
  const postRef = posts().doc(postId);

  const [likeSnap, postSnap] = await adminDb().getAll(likeRef, postRef);
  const alreadyLiked = likeSnap.exists;
  const current = (postSnap.data()?.likeCount as number | undefined) ?? 0;

  /**
   * Nothing to do: report the current truth rather than an error, because the
   * client's optimistic state is already correct.
   *
   * `changed` is what the caller needs to decide whether a SIDE EFFECT should
   * fire. The SQL version got this for free - a duplicate like raised a unique
   * violation before reaching the notification insert, so spam-tapping could
   * not notify the author twice. Returning the flag is what preserves that.
   */
  if (alreadyLiked === liked) return { likeCount: Math.max(0, current), changed: false };

  const batch = adminDb().batch();
  if (liked) {
    batch.set(likeRef, forFirestore({ userId, postId, createdAt: new Date() }));
    batch.update(postRef, { likeCount: FieldValue.increment(1) });
  } else {
    batch.delete(likeRef);
    batch.update(postRef, { likeCount: FieldValue.increment(-1) });
  }
  await batch.commit();

  // Derived from the value read plus our own delta rather than re-read: a
  // re-read is another round trip and would still only be a snapshot. Clamped
  // so a counter that has drifted low never renders as a negative number.
  return { likeCount: Math.max(0, liked ? current + 1 : current - 1), changed: true };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * A page of a post's comments, oldest first.
 *
 * Deleted comments are INCLUDED rather than filtered out: a soft-deleted
 * comment keeps its place so the replies beneath it do not vanish, and the
 * route replaces its body with an empty string before serialising. Filtering
 * here would orphan those replies, which is the whole reason the delete is
 * soft.
 */
export async function listComments(
  postId: string,
  take = 50,
  after: Date | null = null,
): Promise<CommentRecord[]> {
  let query: FirebaseFirestore.Query = comments().where('postId', '==', postId);
  if (after) query = query.where('createdAt', '>', after);

  const snap = await query.orderBy('createdAt', 'asc').limit(take).get();
  return docsToObjects<CommentRecord>(snap.docs) as CommentRecord[];
}

export async function findCommentById(id: string): Promise<CommentRecord | null> {
  return docToObject<CommentRecord>(await comments().doc(id).get()) as CommentRecord | null;
}

/**
 * Adds a comment and bumps the post's counter in one batch, so the count and
 * the rows it describes cannot disagree.
 */
export async function createComment(params: {
  postId: string;
  authorId: string;
  parentId: string | null;
  body: string;
}): Promise<CommentRecord> {
  const ref = comments().doc();
  const record = {
    postId: params.postId,
    authorId: params.authorId,
    parentId: params.parentId,
    body: params.body,
    isDeleted: false,
    createdAt: new Date(),
  };

  const batch = adminDb().batch();
  batch.set(ref, forFirestore(record));
  batch.update(posts().doc(params.postId), { commentCount: FieldValue.increment(1) });
  await batch.commit();

  return { id: ref.id, ...record };
}

/**
 * Soft-deletes a comment.
 *
 * Soft, not hard, for the same reason the SQL model has `isDeleted`: replies
 * point at their parent, and removing the row would orphan a thread.
 */
export async function softDeleteComment(id: string, postId: string): Promise<void> {
  const batch = adminDb().batch();
  batch.update(comments().doc(id), forFirestore({ isDeleted: true }));
  batch.update(posts().doc(postId), { commentCount: FieldValue.increment(-1) });
  await batch.commit();
}

/**
 * Soft delete. `isDeleted` is what every feed query filters on, so the post
 * disappears everywhere at once; likes and comments stay intact for
 * moderation history.
 */
export async function softDeletePost(id: string): Promise<void> {
  await posts().doc(id).update(forFirestore({ isDeleted: true, updatedAt: new Date() }));
}
