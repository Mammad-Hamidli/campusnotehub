/**
 * Video call provisioning.
 *
 * Self-hosted Jitsi rather than a Zoom/Meet redirect, for access control: a
 * Zoom link is a bearer credential anyone can forward, and a mentorship
 * session is a 1-on-1 with a student who may be a minor. Each booking gets an
 * opaque room, sealed into `meetingUrlEnc` at booking time.
 *
 * NOT BUILT YET: the join step. Nothing reveals the sealed URL - the plan was
 * GET /api/bookings/:id/join issuing a per-booking JWT (participants named,
 * mentor as moderator, valid 30 minutes either side of the session). That
 * needs the Jitsi server at meet.campusnotehub.com and JITSI_APP_ID /
 * JITSI_JWT_SECRET, none of which exist. The unused token issuer was removed;
 * it is in git history (src/lib/mentors/meeting.ts at eb88f61).
 */
export async function createMeetingRoom(params: {
  bookingId: string;
  startsAt: Date;
  endsAt: Date;
}) {
  // Room name is opaque - a guessable room name is a way into someone's call.
  const room = `ch-${params.bookingId}`;
  return {
    provider: 'jitsi' as const,
    url: `https://meet.campusnotehub.com/${room}`,
    room,
  };
}
