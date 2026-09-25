import { NextResponse, type NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import { getViewer, requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findPostById, likedPostIds, softDeletePost } from '@/lib/firebase/repositories/posts';
import { deleteMediaAsset, findMediaAsset } from '@/lib/firebase/repositories/media';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { loadVisiblePost } from '@/lib/feed/visibility';
import { serializePost } from '@/lib/feed/serialize';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { mediaIdFromKey } from '@/lib/media/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A Firestore auto-id. Anything else cannot name a post, so it is not looked up. */
const POST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /api/feed/:postId
 *
 * One post, in exactly the shape GET /api/feed returns - this is what a
 * notification link (/dashboard?post=<id>) and a copied post link open.
 *
 * Visibility is loadVisiblePost(), the same rule commenting and liking
 * enforce, so this cannot become a way to read a UNIVERSITY_ONLY or
 * FOLLOWERS post the viewer could not find in their own feed. "Missing" and
 * "not yours to see" are the same 404 on purpose - see that function.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const viewer = await getViewer();
  const { postId } = await params;
  if (!POST_ID.test(postId)) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // Same budget as the feed listing it stands in for.
  const rate = await rateLimit('search', { userId: viewer?.id, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const found = await loadVisiblePost(postId, viewer);
  if (!found) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }
  const { post, author } = found;

  const [universities, liked] = await Promise.all([
    findUniversitiesByIds(author.universityId ? [author.universityId] : []),
    viewer ? likedPostIds([post.id], viewer.id) : Promise.resolve(new Set<string>()),
  ]);

  return NextResponse.json(
    {
      post: serializePost(post, {
        author,
        university: author.universityId ? universities.get(author.universityId) ?? null : null,
        viewerId: viewer?.id,
        viewer,
        likedByViewer: liked.has(post.id),
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

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
