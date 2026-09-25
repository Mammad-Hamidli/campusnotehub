import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NoteReviewError, upsertNoteReview } from '@/lib/firebase/repositories/notes';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { can, denialKey } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().max(1000).optional().nullable(),
});

/**
 * PUT /api/notes/:noteId/reviews - rate a note (1-5 stars), create or update.
 *
 * Any signed-in reader except the note's author; the note's status and
 * authorship are re-read inside the review transaction (upsertNoteReview).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ noteId: string }> },
) {
  let userId: string;
  let viewer;
  try {
    ({ userId, viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }
  // Same gate as buying: only a verified, non-frozen buyer reviews.
  if (!can(viewer, 'notes:review')) {
    return NextResponse.json({ error: denialKey(viewer, 'notes:review') }, { status: 403 });
  }

  const limit = await rateLimit('notes:review', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const { noteId } = await params;
  try {
    const result = await upsertNoteReview({
      userId,
      noteId,
      rating: parsed.data.rating,
      body: parsed.data.body || null,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof NoteReviewError) {
      return NextResponse.json({ error: error.messageKey }, { status: error.status });
    }
    throw error;
  }
}
