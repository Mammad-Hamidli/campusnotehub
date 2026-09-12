import { NextResponse, type NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findPostById, softDeletePost } from '@/lib/firebase/repositories/posts';
import { deleteMediaAsset, findMediaAsset } from '@/lib/firebase/repositories/media';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { mediaIdFromKey } from '@/lib/media/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/feed/:postId
 *
 * The author deletes their own post. Staff may delete any post (moderation).
 * There is deliberately no edit endpoint.
 *
 * A SOFT delete: `isDeleted` is what every feed query already filters on, so
 * the post disappears everywhere at once while its likes and comments stay
 * referentially intact for moderation history. The images are removed for
 * real - they are the part that could still be served by URL.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  let session;
  try {
    session = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const { postId } = await params;
  const post = await findPostById(postId);
  if (!post || post.isDeleted) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const isAuthor = post.authorId === session.userId;
  const isStaff =
    session.viewer.role === UserRole.ADMIN || session.viewer.role === UserRole.MODERATOR;
  if (!isAuthor && !isStaff) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  await softDeletePost(postId);

  // Best effort: a failed image delete must not resurrect the post.
  for (const media of post.media ?? []) {
    const mediaId = mediaIdFromKey(media.storageKey);
    if (!mediaId) continue;
    const asset = await findMediaAsset(mediaId);
    if (asset) {
      await deleteMediaAsset(asset).catch((error) =>
        console.error('[feed] could not delete media %s of post %s', mediaId, postId, error),
      );
    }
  }

  await writeAuditLog({
    actorId: session.userId,
    action: 'POST_DELETED',
    entityType: 'post',
    entityId: postId,
    after: { byStaff: !isAuthor },
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
  });

  return NextResponse.json({ ok: true });
}
