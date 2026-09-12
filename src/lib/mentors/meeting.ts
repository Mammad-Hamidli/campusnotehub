import { SignJWT } from 'jose';
import { openJson } from '@/lib/crypto/vault';
import { findBookingById, findMentorById } from '@/lib/firebase/repositories/mentors';
import { findUserById } from '@/lib/firebase/repositories/users';

/**
 * Video call provisioning.
 *
 * Self-hosted Jitsi with signed JWTs rather than a Zoom/Meet redirect. The
 * reason is access control: a Zoom link is a bearer credential that anyone can
 * forward, and a mentorship session is a 1-on-1 with a student who may be a
 * minor. A per-booking JWT that names the two participants, expires, and is
 * only issued inside the session window is the difference between "private
 * call" and "unlisted URL".
 */
const JOIN_WINDOW_BEFORE_MS = 30 * 60_000;
const JOIN_WINDOW_AFTER_MS = 30 * 60_000;

export async function createMeetingRoom(params: {
  bookingId: string;
  startsAt: Date;
  endsAt: Date;
}) {
  // Room name is opaque - a guessable room name is a way into someone's call.
  const room = `ch-${params.bookingId}`;
  return {
    provider: 'jitsi' as const,
    url: `https://meet.campushub.az/${room}`,
    room,
  };
}

export class MeetingNotOpenError extends Error {
  readonly messageKey = 'mentors.booking.confirmed.body';
}

/**
 * Issues a join token. Called from GET /api/bookings/:id/join, never at
 * booking time - the URL is useless without a token, and tokens only exist
 * during the window.
 */
export async function issueJoinToken(params: { bookingId: string; userId: string }) {
  const booking = await findBookingById(params.bookingId);
  if (!booking) throw new Error('No such booking');

  // The `include` becomes two keyed reads. Concurrent - neither depends on the
  // other, and both are needed before the participant check can be made.
  const [mentor, mentee] = await Promise.all([
    findMentorById(booking.mentorId),
    findUserById(booking.menteeId),
  ]);
  if (!mentor || !mentee) throw new Error('No such booking');

  const isParticipant = booking.menteeId === params.userId || mentor.userId === params.userId;
  if (!isParticipant) throw new Error('Not a participant');

  if (booking.status !== 'CONFIRMED' && booking.status !== 'RESCHEDULED') {
    throw new MeetingNotOpenError();
  }

  const now = Date.now();
  const opensAt = booking.startsAt.getTime() - JOIN_WINDOW_BEFORE_MS;
  const closesAt = booking.endsAt.getTime() + JOIN_WINDOW_AFTER_MS;
  if (now < opensAt || now > closesAt) throw new MeetingNotOpenError();

  const { url } = await openJson<{ url: string }>(booking.meetingUrlEnc!, {
    bookingId: booking.id,
  });

  // The mentor is moderator; the mentee joins as a participant. Without this
  // the mentee could end the call for everyone or admit third parties.
  const isMentor = mentor.userId === params.userId;

  const token = await new SignJWT({
    context: {
      user: { name: mentee.fullName, moderator: isMentor },
    },
    room: `ch-${booking.id}`,
    moderator: isMentor,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(process.env.JITSI_APP_ID!)
    .setAudience('jitsi')
    .setSubject('meet.campushub.az')
    .setExpirationTime(new Date(closesAt))
    .sign(new TextEncoder().encode(process.env.JITSI_JWT_SECRET!));

  return { url: `${url}?jwt=${token}`, expiresAt: new Date(closesAt) };
}
