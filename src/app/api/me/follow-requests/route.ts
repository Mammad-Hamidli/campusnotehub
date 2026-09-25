import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { listIncomingRequests } from '@/lib/firebase/repositories/followRequests';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { visibleAvatar } from '@/lib/profile/visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me/follow-requests - pending requests to follow the viewer, newest
 * first, with just enough of each requester to decide: handle, avatar (if the
 * requester shows it), verified badge. Requests from accounts that have since
 * gone away are left out rather than shown as "@unknown".
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

  const rows = await listIncomingRequests(auth.userId);
  const people = await findUsersByIds(rows.map((r) => r.requesterId));

  const requests = rows.flatMap((row) => {
    const user = people.get(row.requesterId);
    if (!user || user.deletedAt || user.accountStatus === 'BANNED' || user.accountStatus === 'DELETED') return [];
    return [
      {
        requesterId: user.id,
        createdAt: row.createdAt.toISOString(),
        requester: {
          nickname: user.nickname,
          avatarUrl: visibleAvatar(user, auth.viewer),
          isVerified: user.isVerified,
          headline: user.headline,
        },
      },
    ];
  });

  return NextResponse.json({ requests }, { headers: { 'Cache-Control': 'no-store' } });
}
