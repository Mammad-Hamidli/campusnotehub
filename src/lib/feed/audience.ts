/**
 * Post visibility, as queryable tokens.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS: THE SQL RULE HAS NO FIRESTORE EQUIVALENT
 * =============================================================================
 * Under Postgres, "which posts may this viewer see" was one OR of five clauses,
 * one of which reached through a relation:
 *
 *     visibility = 'PUBLIC'
 *  OR authorId = :viewer
 *  OR (visibility = 'FOLLOWERS' AND EXISTS (SELECT 1 FROM follows ...))
 *  OR (visibility = 'VERIFIED_ONLY' AND :viewerIsVerified)
 *  OR (visibility = 'UNIVERSITY_ONLY' AND universityId = :viewerUniversity)
 *
 * Firestore can express none of that in one query. It has no OR across
 * different fields that also orders and pages, and no subquery at all - so the
 * `EXISTS` against the follow graph is simply not sayable.
 *
 * Filtering in application code after a broad read was rejected: the old
 * comment on the feed route is right that "a post the viewer may not see must
 * never leave the database", and a scan-then-filter also breaks pagination,
 * because a page of 20 rows can shrink to 3 after filtering and the cursor no
 * longer means what it says.
 *
 * -----------------------------------------------------------------------------
 * THE APPROACH: DENORMALISE THE AUDIENCE ONTO THE POST
 * -----------------------------------------------------------------------------
 * Each post carries an `audience` array of tokens describing who may read it.
 * Each viewer computes the tokens they hold. The query is then a single
 * indexed `array-contains-any`, which pages correctly and never transfers a
 * document the viewer is not entitled to:
 *
 *     post.audience         viewer tokens
 *     PUBLIC                PUBLIC                  -> everyone
 *     VERIFIED              VERIFIED                -> verified viewers
 *     UNI:<id>              UNI:<their university>  -> same institution
 *     AUTHOR:<id>           AUTHOR:<self>           -> the author, always
 *     FOLLOWERS:<authorId>  FOLLOWERS:<each followed author>
 *
 * AUTHOR is on EVERY post regardless of visibility, which is what reproduces
 * "authors always see their own posts".
 *
 * -----------------------------------------------------------------------------
 * THE ONE LIMIT WORTH KNOWING ABOUT
 * -----------------------------------------------------------------------------
 * `array-contains-any` accepts at most 30 values, and a viewer holds one
 * FOLLOWERS token per account they follow. Past ~27 follows the token set is
 * CHUNKED into several queries whose results are merged - see
 * src/lib/firebase/repositories/posts.ts. That is bounded work proportional to
 * follows/30, not a scan, and the merge preserves the ordering.
 *
 * Denormalised state can drift, so the rules are:
 *   1. `audienceTokens()` is the ONLY writer of the field, called on create.
 *   2. A post whose visibility or university changes must be re-tokenised.
 *   3. The migration backfills it, so existing rows are not a special case.
 */

import { PostVisibility } from '@/lib/enums';

export type AudienceInput = {
  authorId: string;
  visibility: string;
  universityId?: string | null;
};

/**
 * The tokens a post grants. Written to `post.audience` at creation time.
 *
 * A post always grants AUTHOR to its own author, so the author sees it
 * whatever its visibility. The second token is the audience proper.
 */
export function audienceTokens(post: AudienceInput): string[] {
  const tokens = [`AUTHOR:${post.authorId}`];

  switch (post.visibility) {
    case PostVisibility.PUBLIC:
      tokens.push('PUBLIC');
      break;
    case PostVisibility.VERIFIED_ONLY:
      tokens.push('VERIFIED');
      break;
    case PostVisibility.UNIVERSITY_ONLY:
      // A UNIVERSITY_ONLY post with no university would otherwise be readable
      // by nobody but its author, which is the safe direction to fail.
      if (post.universityId) tokens.push(`UNI:${post.universityId}`);
      break;
    case PostVisibility.FOLLOWERS:
      tokens.push(`FOLLOWERS:${post.authorId}`);
      break;
    default:
      // An unrecognised visibility grants nothing beyond AUTHOR. Failing
      // closed matters more here than handling a value that cannot occur.
      break;
  }

  return tokens;
}

/**
 * The tokens a viewer holds.
 *
 * `followingIds` is the set of accounts the viewer follows; each contributes
 * one FOLLOWERS token. A signed-out viewer holds PUBLIC and nothing else,
 * which is the same answer the SQL gave for `viewer === null`.
 */
export function viewerTokens(params: {
  viewerId: string | null;
  isVerified: boolean;
  universityId: string | null;
  followingIds: string[];
}): string[] {
  const tokens = ['PUBLIC'];
  if (!params.viewerId) return tokens;

  tokens.push(`AUTHOR:${params.viewerId}`);
  if (params.isVerified) tokens.push('VERIFIED');
  if (params.universityId) tokens.push(`UNI:${params.universityId}`);
  for (const id of params.followingIds) tokens.push(`FOLLOWERS:${id}`);

  return tokens;
}

/** Firestore's ceiling for `array-contains-any`. */
export const AUDIENCE_TOKEN_LIMIT = 30;

/**
 * Splits a viewer's tokens into query-sized chunks.
 *
 * The base tokens (PUBLIC, AUTHOR, VERIFIED, UNI) are repeated in EVERY chunk
 * rather than isolated in the first one. That looks redundant but is what
 * keeps each chunk a complete query in its own right: a merged page must be
 * able to draw the newest N posts from any chunk, and a chunk that could only
 * return FOLLOWERS posts would starve the merge of public ones whenever a
 * followed author had posted more recently.
 */
export function chunkViewerTokens(tokens: string[]): string[][] {
  if (tokens.length <= AUDIENCE_TOKEN_LIMIT) return [tokens];

  const base = tokens.filter((t) => !t.startsWith('FOLLOWERS:'));
  const follows = tokens.filter((t) => t.startsWith('FOLLOWERS:'));
  const room = AUDIENCE_TOKEN_LIMIT - base.length;

  // Cannot happen with the current four base tokens, but a future addition
  // that filled the budget would silently produce empty chunks otherwise.
  if (room <= 0) return [base.slice(0, AUDIENCE_TOKEN_LIMIT)];

  const chunks: string[][] = [];
  for (let i = 0; i < follows.length; i += room) {
    chunks.push([...base, ...follows.slice(i, i + room)]);
  }
  return chunks;
}
