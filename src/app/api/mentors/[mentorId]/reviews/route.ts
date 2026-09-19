import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { MentorReviewError, upsertMentorReview } from '@/lib/firebase/repositories/mentors';
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
 * PUT /api/mentors/:mentorId/reviews - rate a mentor (1-5 stars, optional
 * comment), create or update.
 *
 * The mentor-side twin of PUT /api/notes/:noteId/reviews. Finished session
 * only: the booking is re-read inside the review transaction
 * (upsertMentorReview), never inferred from the client.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ mentorId: string }> },
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
  // Same gate as booking: only a verified, non-frozen mentee reviews.
  if (!can(viewer, 'mentors:book')) {
    return NextResponse.json({ error: denialKey(viewer, 'mentors:book') }, { status: 403 });
  }

  const limit = await rateLimit('mentors:review', { userId, ip: clientIp(request.headers) });
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

  const { mentorId } = await params;
  try {
    const result = await upsertMentorReview({
      mentorId,
      menteeId: userId,
      rating: parsed.data.rating,
      body: parsed.data.body || null,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof MentorReviewError) {
      return NextResponse.json({ error: error.messageKey }, { status: error.status });
    }
    throw error;
  }
}
