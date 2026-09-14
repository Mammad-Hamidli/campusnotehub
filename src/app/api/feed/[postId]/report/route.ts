import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ReportReason } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { forFirestore } from '@/lib/firebase/convert';
import { findVisiblePost } from '@/lib/feed/visibility';
import { toPlainText } from '@/lib/security/plainText';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reportSchema = z.object({
  reason: z.nativeEnum(ReportReason).optional(),
  details: z.string().max(2000).transform(toPlainText).pipe(z.string().max(1000)).optional(),
});

/**
 * POST /api/feed/:postId/report
 *
 * Files a content report for moderators. One report per (reporter, post): the
 * document id is derived from both, so reporting twice is a no-op rather than
 * a way to inflate a post's report count.
 */
export async function POST(
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

  const parsed = reportSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const { postId } = await params;
  const post = await findVisiblePost(postId, session.viewer);
  if (!post) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  if (post.authorId === session.userId) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const ref = adminDb()
    .collection(COLLECTIONS.contentReports)
    .doc(`post__${postId}__${session.userId}`);

  try {
    await ref.create(
      forFirestore({
        targetType: 'post',
        targetId: postId,
        targetAuthorId: post.authorId,
        reporterId: session.userId,
        reason: parsed.data.reason ?? null,
        details: parsed.data.details ?? null,
        status: 'OPEN',
        createdAt: new Date(),
      }),
    );
  } catch (error) {
    // ALREADY_EXISTS: this reader has reported this post before.
    if ((error as { code?: number }).code !== 6) throw error;
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
