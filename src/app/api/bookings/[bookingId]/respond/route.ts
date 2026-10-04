import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { respondSchema } from '@/lib/mentors/requests';
import { RequestError, respondToRequest } from '@/lib/mentors/request-service';
import { provisionMeeting, type ProvisionResult } from '@/lib/mentors/meeting';
import { BookingError } from '@/lib/mentors/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Accepting creates the Google Meet room before answering; leave it room.
export const maxDuration = 30;

/** New ids are 32 hex chars; legacy ones are mentorId__epochMs. */
const BOOKING_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * POST /api/bookings/:bookingId/respond
 *   { action: 'accept' } | { action: 'reject', reason: string (10-500) }
 *
 * The mentor's Accept / Decline, from the notification panel or the mentor
 * panel. Access control, in order:
 *
 *   1. a live session                              401
 *   2. the mentor capability (role MENTOR or a mentorSince stamp, and an
 *      account that is not frozen/banned)          403
 *   3. OWNERSHIP - the booking was requested from THIS mentor - checked
 *      against the booking inside the transaction  404 (never 403: booking
 *      ids are not confirmable by probing)
 *
 * Answers:
 *   200 { status: 'CONFIRMED', meetingStatus }   accepted; the Meet room is
 *       created before answering, and if Google is slow or down the session
 *       is still confirmed with meetingStatus PENDING (retried later).
 *   200 { status: 'REJECTED' }
 *   409 alreadyAnswered | slotTaken | menteeBusy | calendarRequired
 *   410 expired - the deadline passed; the request is closed as EXPIRED.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) {
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

  if (!can(viewer, 'mentors:console')) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  const rate = await rateLimit('bookings:respond', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const { bookingId } = await params;
  const parsed = respondSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !BOOKING_ID.test(bookingId)) {
    const reasonMissing =
      parsed.error?.issues.some((issue) => issue.path[0] === 'reason') ?? false;
    return NextResponse.json(
      { error: reasonMissing ? 'mentors.requests.errors.reasonRequired' : 'errors.validationFailed' },
      { status: 400 },
    );
  }

  try {
    const { outcome } = await respondToRequest({ bookingId, actorId: userId, input: parsed.data });

    if (outcome === 'EXPIRED') {
      return NextResponse.json({ error: 'mentors.requests.errors.expired', status: 'EXPIRED' }, { status: 410 });
    }
    if (outcome === 'REJECTED') return NextResponse.json({ status: 'REJECTED' });

    let meetingStatus: ProvisionResult = 'PENDING';
    try {
      meetingStatus = await provisionMeeting(bookingId);
    } catch (error) {
      // Never un-confirms the session: the scheduled MEETING_PROVISION task
      // and the join route both try again.
      console.error('[bookings] meeting provisioning threw for %s', bookingId, error);
    }
    return NextResponse.json({ status: 'CONFIRMED', meetingStatus });
  } catch (error) {
    if (error instanceof RequestError) {
      return NextResponse.json({ error: error.messageKey, params: error.params }, { status: error.status });
    }
    if (error instanceof BookingError) {
      return NextResponse.json({ error: error.messageKey, params: error.params }, { status: 409 });
    }
    throw error;
  }
}
