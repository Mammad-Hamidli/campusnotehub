import { Prisma, PostVisibility, VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import type { Viewer } from '@/lib/permissions';

/**
 * "Which posts may this viewer see", as a Prisma WHERE fragment.
 *
 * Extracted from the feed listing so that commenting and liking enforce the
 * SAME rule the listing does. Before this existed the rule lived inline in
 * GET /api/feed only, which meant any new endpoint taking a postId had to
 * re-derive it - and the predictable outcome is an endpoint that lets someone
 * comment on a UNIVERSITY_ONLY post they could never have read, turning a
 * write endpoint into an oracle for private content.
 *
 * The clauses are built by PUSHING rather than by neutralising an unwanted
 * clause with a sentinel value, so a condition that does not apply is
 * genuinely absent from the generated SQL rather than present-but-false.
 */
export function visibilityWhere(
  viewer: Viewer | null,
  viewerUniversityId: string | null,
): Prisma.PostWhereInput {
  if (!viewer) return { visibility: PostVisibility.PUBLIC };

  const clauses: Prisma.PostWhereInput[] = [
    { visibility: PostVisibility.PUBLIC },
    // Authors always see their own posts, whatever the visibility.
    { authorId: viewer.id },
    {
      visibility: PostVisibility.FOLLOWERS,
      author: { followers: { some: { followerId: viewer.id } } },
    },
  ];

  if (viewer.verificationStatus === VerificationStatus.VERIFIED) {
    clauses.push({ visibility: PostVisibility.VERIFIED_ONLY });
  }
  if (viewerUniversityId) {
    clauses.push({
      visibility: PostVisibility.UNIVERSITY_ONLY,
      universityId: viewerUniversityId,
    });
  }

  return { OR: clauses };
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
  const row = await db.user.findUnique({
    where: { id: viewer.id },
    select: { universityId: true },
  });
  return row?.universityId ?? null;
}

/**
 * Loads a post the viewer is allowed to interact with, or null.
 *
 * Returning null for BOTH "no such post" and "not allowed to see it" is
 * deliberate: distinguishing them tells an unauthorised caller that a given id
 * exists, which is exactly the enumeration this check is meant to prevent.
 * Callers answer 404 in both cases.
 */
export async function findVisiblePost(
  postId: string,
  viewer: Viewer | null,
): Promise<{ id: string; authorId: string; commentCount: number } | null> {
  const universityId = await viewerUniversityId(viewer);

  return db.post.findFirst({
    where: {
      id: postId,
      isDeleted: false,
      author: { accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } },
      ...visibilityWhere(viewer, universityId),
    },
    select: { id: true, authorId: true, commentCount: true },
  });
}
