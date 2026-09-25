import { VerificationStatus } from '@/lib/enums';
import { findUserById, type UserRecord } from '@/lib/firebase/repositories/users';
import { followingIds } from '@/lib/firebase/repositories/follows';
import { findPostById, type PostRecord } from '@/lib/firebase/repositories/posts';
import { viewerTokens } from '@/lib/feed/audience';
import type { Viewer } from '@/lib/permissions';

/**
 * "Which posts may this viewer see."
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE STILL EXISTS AFTER THE MOVE TO FIRESTORE
 * ---------------------------------------------------------------------------
 * It was extracted so that commenting and liking enforce the SAME rule the
 * listing does. Before it existed the rule lived inline in GET /api/feed only,
 * which meant any new endpoint taking a postId had to re-derive it - and the
 * predictable outcome is an endpoint that lets someone comment on a
 * UNIVERSITY_ONLY post they could never have read, turning a write endpoint
 * into an oracle for private content. That reason is unchanged.
 *
 * What changed is the FORM of the rule. It used to return a Prisma `WHERE`
 * fragment; Firestore cannot express the same predicate as a query, so the
 * rule is now a set of audience TOKENS matched against the post's own
 * `audience` array. See src/lib/feed/audience.ts for why.
 *
 * The security property is identical either way: a post the viewer may not see
 * is never returned by the query, rather than being fetched and then filtered.
 */

/**
 * Everything needed to ask "may this viewer see a post", gathered once.
 *
 * The two reads (the viewer's university, the accounts they follow) are the
 * same two the SQL predicate needed - it just took them as a join and a
 * subquery instead. They run concurrently, and a signed-out viewer costs
 * neither.
 */
export type ViewerAudience = {
  tokens: string[];
  universityId: string | null;
  followingIds: string[];
};

export async function resolveViewerAudience(viewer: Viewer | null): Promise<ViewerAudience> {
  if (!viewer) {
    return { tokens: viewerTokens({ viewerId: null, isVerified: false, universityId: null, followingIds: [] }), universityId: null, followingIds: [] };
  }

  const [record, follows] = await Promise.all([
    findUserById(viewer.id),
    followingIds(viewer.id),
  ]);

  const universityId = record?.universityId ?? null;

  return {
    tokens: viewerTokens({
      viewerId: viewer.id,
      isVerified: viewer.verificationStatus === VerificationStatus.VERIFIED,
      universityId,
      followingIds: follows,
    }),
    universityId,
    followingIds: follows,
  };
}

/**
 * Resolves the viewer's own university.
 *
 * Always from their record, never from a query string: trusting a client
 * supplied `universityId` would let anyone read another university's private
 * feed by editing a URL.
 */
export async function viewerUniversityId(viewer: Viewer | null): Promise<string | null> {
  if (!viewer) return null;
  return (await findUserById(viewer.id))?.universityId ?? null;
}

/**
 * Loads a post the viewer is allowed to interact with, or null.
 *
 * Returning null for BOTH "no such post" and "not allowed to see it" is
 * deliberate: distinguishing them tells an unauthorised caller that a given id
 * exists, which is exactly the enumeration this check is meant to prevent.
 * Callers answer 404 in both cases.
 *
 * ---------------------------------------------------------------------------
 * READ-THEN-CHECK, AND WHY THAT IS SOUND HERE
 * ---------------------------------------------------------------------------
 * The feed LISTING must never transfer a post the viewer cannot see, because
 * it queries a whole collection. This function is different: the caller
 * already holds a specific post id, so the document is fetched by key and the
 * entitlement is checked before anything is returned or acted upon. Nothing
 * about the post reaches the caller - or the response - unless the check
 * passes, so the token intersection below is the same boundary the query-level
 * filter provides, applied to a single keyed read.
 */
export async function findVisiblePost(
  postId: string,
  viewer: Viewer | null,
): Promise<{ id: string; authorId: string; commentCount: number } | null> {
  const found = await loadVisiblePost(postId, viewer);
  if (!found) return null;
  const { post } = found;
  return { id: post.id, authorId: post.authorId, commentCount: post.commentCount ?? 0 };
}

/**
 * The same check as findVisiblePost(), returning the full post and its author
 * for a caller that renders the post (GET /api/feed/:postId) rather than
 * acting on it. One rule, two shapes - never a second copy of the rule.
 */
export async function loadVisiblePost(
  postId: string,
  viewer: Viewer | null,
): Promise<{ post: PostRecord; author: UserRecord } | null> {
  const post = await findPostById(postId);
  if (!post || post.isDeleted) return null;

  /**
   * Content from banned accounts disappears without a separate cleanup job.
   * This was `author: { accountStatus: { in: [...] } }` in the SQL join, and
   * it has to be an explicit read now - there is no join to hang it on.
   */
  const author = await findUserById(post.authorId);
  if (!author || author.deletedAt) return null;
  if (author.accountStatus !== 'ACTIVE' && author.accountStatus !== 'RESTRICTED') return null;

  const { tokens } = await resolveViewerAudience(viewer);
  const granted = new Set(post.audience ?? []);
  if (!tokens.some((token) => granted.has(token))) return null;

  return { post, author };
}
