import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findPostById, setPostSaved } from '@/lib/firebase/repositories/posts';
import { resolveViewerAudience } from '@/lib/feed/visibility';

const schema = z.object({ saved: z.boolean() });

/** POST /api/feed/:postId/save - private, idempotent bookmark toggle. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  let viewer;
  try {
    ({ viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    throw error;
  }
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  const { postId } = await params;
  const post = await findPostById(postId);
  if (!post || post.isDeleted) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  if (body.data.saved) {
    const audience = await resolveViewerAudience(viewer);
    if (!post.audience?.some((token) => audience.tokens.includes(token))) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
  }
  await setPostSaved(viewer.id, postId, body.data.saved);
  return NextResponse.json({ postId, saved: body.data.saved }, { headers: { 'Cache-Control': 'no-store' } });
}
