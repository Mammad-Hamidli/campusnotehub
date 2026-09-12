import { NextResponse, type NextRequest } from 'next/server';
import { NotificationType } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { findVisiblePost } from '@/lib/feed/visibility';
import { setPostLike } from '@/lib/firebase/repositories/posts';
import { createNotification } from '@/lib/firebase/repositories/notifications';

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
 * Both verbs are IDEMPOTENT, which the like document being KEYED BY THE LIKER
 * gives for free - the Firestore equivalent of the composite (postId, userId)
 * primary key the SQL table had. A double-tap or a retried request on a flaky
 * connection cannot double-count. That property is what lets the client update
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

  /**
   * setPostLike reports whether the state actually changed by returning the
   * resulting count; liking an already-liked post is a no-op that returns the
   * current total. The SQL version got that from catching a unique violation -
   * here it falls out of the document being keyed by the liker, so no
   * exception is used as control flow.
   */
  const { likeCount, changed } = await setPostLike(postId, auth.userId, true);

  /**
   * The notification is written AFTER the like, not with it.
   *
   * Firestore cannot span a transaction across the post's like subcollection
   * and the notifications collection in a way this module could express
   * cleanly, and the two do not need to be atomic: a like without its
   * notification is a missed bell, while a notification without its like would
   * be a lie about something that never happened. The recoverable failure is
   * the one left possible.
   *
   * Nobody is notified about liking their own post, and nobody is notified
   * TWICE: `changed` is false when the like was already there, so a double-tap
   * or a retried request cannot fan out a second notification. Under SQL the
   * duplicate raised a unique violation before this line was reached; the flag
   * is what reproduces that.
   */
  if (changed && post.authorId !== auth.userId) {
    await createNotification({
      userId: post.authorId,
      type: NotificationType.POST_LIKE,
      titleKey: 'notifications.postLike.title',
      bodyKey: 'notifications.postLike.body',
      linkUrl: `/dashboard?post=${postId}`,
    });
  }

  return NextResponse.json({ liked: true, likeCount }, { headers: { 'Cache-Control': 'no-store' } });
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

  /**
   * The counter moves ONLY when a like was actually removed. Decrementing
   * unconditionally lets a repeated DELETE drive the counter negative, which
   * is how a "-3 likes" bug is born - setPostLike enforces that by comparing
   * the current state before writing anything.
   */
  const { likeCount } = await setPostLike(postId, auth.userId, false);

  return NextResponse.json({ liked: false, likeCount }, { headers: { 'Cache-Control': 'no-store' } });
}
