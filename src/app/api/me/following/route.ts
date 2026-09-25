import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { followingIds } from '@/lib/firebase/repositories/follows';
import { findUsersByIds } from '@/lib/firebase/repositories/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me/following - the handles the viewer follows, lowercased.
 *
 * Feeds the "Following" badge shown next to a name anywhere in the UI (see
 * FollowingProvider). Handles rather than ids because several surfaces - note
 * sellers, mentor reviewers - only ever receive the nickname. Resolved from
 * the ids on every call, so a rename can never leave a stale handle behind.
 */
export async function GET(request: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const people = await findUsersByIds(await followingIds(userId));
  const nicknames = [...people.values()]
    .filter(
      (u) =>
        !u.deletedAt &&
        u.accountStatus !== AccountStatus.BANNED &&
        u.accountStatus !== AccountStatus.DELETED &&
        u.profileIncomplete !== true,
    )
    .map((u) => u.nicknameLower);

  return NextResponse.json({ nicknames }, { headers: { 'Cache-Control': 'no-store' } });
}
