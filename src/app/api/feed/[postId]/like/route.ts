import { NextResponse, type NextRequest } from 'next/server';
import { NotificationType, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { findVisiblePost } from '@/lib/feed/visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Likes.
 *
 * The card's optimistic toggle was written against these two endpoints and
 * they did not exist - the fetch call was commented out in PostCard.tsx, so a
 * like flipped the icon and was forgotten on the next render. This is the
 * other half of that feature.
 *
 * Both verbs are IDEMPOTENT, which the composite (postId, userId) primary key
 * gives for free: a double-tap or a retried request on a flaky connection
 * cannot double-count. That property is what lets the client update
 * optimistically without reconciling a running total.
 */

async function authorize(request: NextRequest) {
  const { userId, viewer } = await requireSession(request);
  if (!can(viewer, 'feed:read')) {
    return { error: NextResponse.json({ error: 'errors.forbidden' }, { status: 403 }) } as const;
  }
  return { userId, viewer } as const;
}

/** POST - like. Creating an existing like is a no-op, not an error. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;

  let auth;
  try {
    auth = await authorize(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }
  if ('error' in auth) return auth.error;

  const post = await findVisiblePost(postId, auth.viewer);
  if (!post) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  try {
    const likeCount = await db.$transaction(async (tx) => {
      // Throws P2002 when the like already exists, which is caught below. The
      // alternative - findFirst then create - is a race that double-counts
      // under a double-tap, which is exactly the traffic this endpoint gets.
      await tx.postLike.create({ data: { postId, userId: auth.userId } });

      const updated = await tx.post.update({
        where: { id: postId },
        data: { likeCount: { increment: 1 } },
        select: { likeCount: true },
      });

      if (post.authorId !== auth.userId) {
        await tx.notification.create({
          data: {
            userId: post.authorId,
            type: NotificationType.POST_LIKE,
            titleKey: 'notifications.postLike.title',
            bodyKey: 'notifications.postLike.body',
            linkUrl: `/dashboard?post=${postId}`,
          },
        });
      }

      return updated.likeCount;
    });

    return NextResponse.json({ liked: true, likeCount }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Already liked. Report the current truth rather than an error: the
      // client's optimistic state is already correct.
      const current = await db.post.findUnique({ where: { id: postId }, select: { likeCount: true } });
      return NextResponse.json({ liked: true, likeCount: current?.likeCount ?? 0 });
    }
    throw error;
  }
}

/** DELETE - unlike. Removing a like that is not there is a no-op. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;

  let auth;
  try {
    auth = await authorize(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }
  if ('error' in auth) return auth.error;

  const post = await findVisiblePost(postId, auth.viewer);
  if (!post) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const likeCount = await db.$transaction(async (tx) => {
    const removed = await tx.postLike.deleteMany({ where: { postId, userId: auth.userId } });

    // Decrement ONLY when a row was actually removed. Decrementing
    // unconditionally lets a repeated DELETE drive the counter negative, which
    // is how a "-3 likes" bug is born.
    if (removed.count === 0) {
      const current = await tx.post.findUnique({ where: { id: postId }, select: { likeCount: true } });
      return current?.likeCount ?? 0;
    }

    const updated = await tx.post.update({
      where: { id: postId },
      data: { likeCount: { decrement: 1 } },
      select: { likeCount: true },
    });
    return updated.likeCount;
  });

  return NextResponse.json({ liked: false, likeCount }, { headers: { 'Cache-Control': 'no-store' } });
}
