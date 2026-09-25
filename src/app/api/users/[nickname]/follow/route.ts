import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus, NotificationType } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, denialKey } from '@/lib/permissions';
import { usernameKey } from '@/lib/auth/username';
import { findUserById, findUserByNickname } from '@/lib/firebase/repositories/users';
import { followerCount, isFollowing, unfollow } from '@/lib/firebase/repositories/follows';
import { cancelFollowRequest, createFollowRequest } from '@/lib/firebase/repositories/followRequests';
import { createNotification } from '@/lib/firebase/repositories/notifications';
import { sendEmailAsync } from '@/lib/email/send';
import { appUrl } from '@/lib/email/urls';
import { rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST   /api/users/:nickname/follow - ask to follow (a follow REQUEST)
 * DELETE /api/users/:nickname/follow - unfollow, or withdraw a pending request
 *
 * Following needs the target's consent: POST files a request, which the target
 * accepts or rejects from /notifications (POST /api/me/follow-requests/:id).
 * The response reports `{ following, requested, followers }` so the button can
 * show Follow / Requested / Following without guessing.
 *
 * NO COOLDOWN. A rejection deletes the request and leaves no trace, and this
 * route has no rate limit, so a rejected requester can ask again at once. Only
 * the EMAIL is throttled (once per pair per hour, see `email:followRequest`),
 * so withdraw-and-resend cannot flood the target's inbox; the in-app
 * notification is written every time a new request is filed.
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
  // asking to follow is an interaction, gated like any other.
  if (following && !can(viewer, 'users:follow')) {
    return NextResponse.json({ error: denialKey(viewer, 'users:follow') }, { status: 403 });
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

  const already = await isFollowing(userId, target.id);
  let requested = false;

  if (!following) {
    await Promise.all([already ? unfollow(userId, target.id) : null, cancelFollowRequest(userId, target.id)]);
  } else if (!already) {
    requested = true;
    const outcome = await createFollowRequest(userId, target.id);
    // An identical pending request is not re-announced; a NEW one always is.
    if (outcome === 'created') await announceRequest(userId, target);
  }

  const followers = await followerCount(target.id);
  return NextResponse.json(
    { following: following && already, requested, followers },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** In-app notification (always) and email (throttled per pair). Never fails the request. */
async function announceRequest(
  requesterId: string,
  target: { id: string; email: string; nickname: string },
): Promise<void> {
  const me = await findUserById(requesterId);
  if (!me) return;

  await createNotification({
    userId: target.id,
    type: NotificationType.FOLLOW_REQUEST,
    titleKey: 'notifications.followRequest.title',
    bodyKey: 'notifications.followRequest.body',
    params: { nickname: me.nickname },
    linkUrl: '/notifications',
  }).catch((error) => console.error('[follow] notification failed', error));

  const mail = await rateLimit('email:followRequest', {
    ip: 'follow-request',
    subject: `${requesterId}>${target.id}`,
  }).catch(() => ({ ok: false }));
  if (mail.ok && target.email) {
    sendEmailAsync(target.email, 'followRequest', {
      nickname: target.nickname,
      requester: me.nickname,
      url: appUrl('/notifications'),
    });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ nickname: string }> }) {
  return handle(request, (await params).nickname, true);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ nickname: string }> }) {
  return handle(request, (await params).nickname, false);
}
