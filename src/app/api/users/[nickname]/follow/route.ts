import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus, NotificationType } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, denialKey } from '@/lib/permissions';
import { usernameKey } from '@/lib/auth/username';
import { findUserById, findUserByNickname } from '@/lib/firebase/repositories/users';
import { follow, followerCount, isFollowing, unfollow } from '@/lib/firebase/repositories/follows';
import { createNotification } from '@/lib/firebase/repositories/notifications';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST   /api/users/:nickname/follow - follow
 * DELETE /api/users/:nickname/follow - unfollow
 *
 * Both idempotent: the follow edge is keyed by the other party (follows.ts),
 * so a double-tap cannot double-count, and the client can update
 * optimistically. The response carries the server's follower count so the
 * button never drifts from reality.
 */
async function handle(request: NextRequest, nicknameParam: string, following: boolean) {
  let auth;
  try {
    auth = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }
  const { userId, viewer } = auth;

  // Unfollowing is always allowed (it only removes the viewer's own edge);
  // following is an interaction, gated like any other.
  if (following && !can(viewer, 'users:follow')) {
    return NextResponse.json({ error: denialKey(viewer, 'users:follow') }, { status: 403 });
  }

  const rate = await rateLimit('users:follow', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const key = usernameKey(decodeURIComponent(nicknameParam));
  const target = key ? await findUserByNickname(key) : null;
  if (
    !target ||
    target.deletedAt ||
    target.accountStatus === AccountStatus.BANNED ||
    target.accountStatus === AccountStatus.DELETED ||
    target.profileIncomplete === true
  ) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }
  if (target.id === userId) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const before = await isFollowing(userId, target.id);
  if (following && !before) {
    const [, me] = await Promise.all([follow(userId, target.id), findUserById(userId)]);
    // After the write, never with it: a follow without its bell is a missed
    // notification, a bell without its follow would be a lie.
    if (me) {
      await createNotification({
        userId: target.id,
        type: NotificationType.NEW_FOLLOWER,
        titleKey: 'notifications.newFollower.title',
        bodyKey: 'notifications.newFollower.body',
        params: { nickname: me.nickname },
        linkUrl: `/u/${me.nickname}`,
      }).catch(() => {});
    }
  } else if (!following && before) {
    await unfollow(userId, target.id);
  }

  const followers = await followerCount(target.id);
  return NextResponse.json({ following, followers }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ nickname: string }> }) {
  return handle(request, (await params).nickname, true);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ nickname: string }> }) {
  return handle(request, (await params).nickname, false);
}
