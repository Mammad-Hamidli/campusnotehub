import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { appBase } from '@/lib/auth/oauth/http';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { findBookingById, mentorUserIdOf } from '@/lib/firebase/repositories/mentors';
import { JOINABLE_STATUSES, joinState } from '@/lib/mentors/requests';
import { provisionMeeting, revealMeetingUrl } from '@/lib/mentors/meeting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/bookings/:bookingId/join - "Join Google Meet".
 *
 * THE ONLY PLACE THE MEET LINK IS EVER REVEALED. It opens the sealed URL and
 * redirects to it when, and only when:
 *
 *   - the viewer is one of the two participants (anyone else is sent to the
 *     session page, which 404s for them);
 *   - the session is confirmed;
 *   - now is inside the join window: 30 minutes before the start until 15
 *     minutes after the end (src/lib/mentors/requests.ts).
 *
 * Google Meet itself cannot time-lock a link, so this is what "the link
 * becomes active 30 minutes before" means - see src/lib/mentors/meeting.ts.
 * Every other outcome lands back on the session page with a reason
 * (?join=early|closed|pending), which explains it in the viewer's language.
 *
 * If the room is not ready yet (Google was down at accept time), this is the
 * moment someone needs it, so it tries to create it once more right here.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) return back(request, null);
  const sessionPage = `/sessions/${bookingId}`;

  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return redirect(request, `/login?next=${encodeURIComponent(sessionPage)}`);
    }
    throw error;
  }

  const rate = await rateLimit('bookings:join', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) return back(request, bookingId, 'rate_limited');

  let booking = await findBookingById(bookingId);
  if (!booking) return back(request, bookingId);
  const isParticipant = booking.menteeId === userId || (await mentorUserIdOf(booking)) === userId;
  if (!isParticipant || !JOINABLE_STATUSES.has(booking.status)) return back(request, bookingId);

  const state = joinState(booking, new Date());
  if (state !== 'open') return back(request, bookingId, state);

  if (booking.meetingStatus !== 'READY') {
    await provisionMeeting(bookingId).catch((error) => console.error('[join] provisioning failed', error));
    booking = await findBookingById(bookingId);
  }
  const url = booking ? await revealMeetingUrl(booking) : null;
  if (!url) return back(request, bookingId, 'pending');

  // An external URL, but one isMeetUrl() has pinned to https://meet.google.com.
  const response = NextResponse.redirect(url, 303);
  response.headers.set('Cache-Control', 'no-store, private');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function redirect(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, appBase(request)), 303);
  response.headers.set('Cache-Control', 'no-store, private');
  return response;
}

function back(request: NextRequest, bookingId: string | null, reason?: string): NextResponse {
  if (!bookingId) return redirect(request, '/dashboard');
  return redirect(request, `/sessions/${bookingId}${reason ? `?join=${reason}` : ''}`);
}
