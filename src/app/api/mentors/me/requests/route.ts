import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { findMentorByUserId, listPendingRequests } from '@/lib/firebase/repositories/mentors';
import { findCalendarLink } from '@/lib/firebase/repositories/calendarLinks';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { visibleAvatar } from '@/lib/profile/visibility';
import { visibilityRelationshipsFor } from '@/lib/profile/visibility.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mentors/me/requests - the session requests waiting for the
 * viewer's answer, for the Accept / Decline controls on BOOKING_REQUESTED
 * notifications. Only the viewer's OWN profile is read; there is no way to ask
 * for another mentor's requests. Lapsed requests are left out (they can no
 * longer be accepted), and so are requests from accounts that have gone away.
 *
 * `calendarConnected` lets the panel say "connect Google Calendar first"
 * before the mentor presses Accept, rather than after.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const empty = { requests: [], calendarConnected: false };
  if (!can(auth.viewer, 'mentors:console')) {
    return NextResponse.json(empty, { headers: { 'Cache-Control': 'no-store' } });
  }

  const [profile, link] = await Promise.all([findMentorByUserId(auth.userId), findCalendarLink(auth.userId)]);
  if (!profile) return NextResponse.json(empty, { headers: { 'Cache-Control': 'no-store' } });

  const pending = await listPendingRequests(profile.id, new Date());
  const mentees = await findUsersByIds(pending.map((b) => b.menteeId));
  const relationships = await visibilityRelationshipsFor([...mentees.keys()], auth.viewer);

  const requests = pending.flatMap((booking) => {
    const mentee = mentees.get(booking.menteeId);
    if (!mentee || mentee.deletedAt || mentee.accountStatus === 'BANNED' || mentee.accountStatus === 'DELETED') {
      return [];
    }
    return [
      {
        id: booking.id,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        requestExpiresAt: booking.requestExpiresAt?.toISOString() ?? null,
        topic: booking.topic,
        menteeNote: booking.menteeNote,
        mentee: {
          nickname: mentee.nickname,
          avatarUrl: visibleAvatar(mentee, auth.viewer, relationships.get(mentee.id)),
          isVerified: mentee.isVerified,
        },
      },
    ];
  });

  return NextResponse.json(
    { requests, calendarConnected: link?.status === 'ACTIVE' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
