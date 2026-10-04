import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { findMentorById } from '@/lib/firebase/repositories/mentors';
import { findUserById } from '@/lib/firebase/repositories/users';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { assertSlotBookable, BookingError, getDaySlots } from '@/lib/mentors/availability';
import { createSessionRequest, sendRequestEmail } from '@/lib/mentors/request-service';

export const runtime = 'nodejs';

const listSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().max(64).default('Asia/Baku'),
});

/** GET /api/mentors/:id/bookings?date=YYYY-MM-DD - the slot picker's data source. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mentorId: string }> },
) {
  const { mentorId } = await params;
  const query = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });

  const slots = await getDaySlots({
    mentorId,
    date: query.data.date,
    viewerTimezone: query.data.tz,
  });

  return NextResponse.json({
    date: query.data.date,
    timezone: query.data.tz,
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      available: s.available,
    })),
  });
}

const createSchema = z.object({
  startsAt: z.string().datetime(),
  topic: z.string().trim().min(5).max(300),
  menteeNote: z.string().trim().max(2000).optional(),
  idempotencyKey: z.string().uuid(),
});

/**
 * POST /api/mentors/:id/bookings - REQUEST a session.
 *
 * Nothing is confirmed here any more. The booking is written as REQUESTED and
 * holds the slot until the mentor answers (POST /api/bookings/:id/respond) or
 * the request lapses (src/lib/mentors/requests.ts). The mentor is told twice:
 * an in-app notification carrying Accept / Decline, and an email.
 *
 * The request, its notification and its expiry task commit in ONE
 * transaction that also re-runs the overlap checks - see createSessionRequest.
 * A retried submit (same idempotency key) answers 200 with the original
 * request instead of a second one. Bookings are free; nothing is charged.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ mentorId: string }> },
) {
  const { mentorId } = await params;

  /**
   * Answered, never thrown: a thrown ForbiddenError that nothing caught meant an
   * UNVERIFIED student pressing Book - the single most likely refusal on this
   * endpoint, since booking is exactly what verification gates - got a 500
   * with a stack trace instead of a message telling them to verify.
   */
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

  if (!can(viewer, 'mentors:book')) {
    return NextResponse.json({ error: 'verification.restricted.title' }, { status: 403 });
  }

  const rate = await rateLimit('bookings:create', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });

  const startsAt = new Date(parsed.data.startsAt);

  try {
    // The courtesy checks with good error messages (self-booking, notice,
    // availability). The binding ones re-run inside the transaction.
    const { endsAt, sessionMinutes } = await assertSlotBookable({ mentorId, startsAt, menteeId: userId });
    const [mentor, mentee] = await Promise.all([findMentorById(mentorId), findUserById(userId)]);
    if (!mentor || !mentee) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

    const { booking, replay } = await createSessionRequest({
      mentor: { id: mentor.id, userId: mentor.userId, timezone: mentor.timezone },
      menteeId: userId,
      menteeNickname: mentee.nickname,
      startsAt,
      endsAt,
      sessionMinutes,
      topic: parsed.data.topic,
      menteeNote: parsed.data.menteeNote || null,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    if (!replay) sendRequestEmail(booking, mentee.nickname);

    return NextResponse.json(
      {
        booking: {
          id: booking.id,
          startsAt: booking.startsAt.toISOString(),
          endsAt: booking.endsAt.toISOString(),
          status: booking.status,
          requestExpiresAt: booking.requestExpiresAt?.toISOString() ?? null,
        },
        messageKey: 'mentors.booking.requested.body',
      },
      { status: replay ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof BookingError) {
      return NextResponse.json({ error: error.messageKey, params: error.params }, { status: 409 });
    }
    throw error;
  }
}
