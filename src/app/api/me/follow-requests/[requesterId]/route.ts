import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NotificationType } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { acceptFollowRequest, rejectFollowRequest } from '@/lib/firebase/repositories/followRequests';
import { followerCount } from '@/lib/firebase/repositories/follows';
import { createNotification } from '@/lib/firebase/repositories/notifications';
import { findUserById } from '@/lib/firebase/repositories/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ action: z.enum(['accept', 'reject']) });

/**
 * POST /api/me/follow-requests/:requesterId { action: 'accept' | 'reject' }
 *
 * Only the TARGET can answer: the request id is derived from the path's
 * requester and the session's user, so nobody can accept a request on someone
 * else's behalf. Rejecting deletes the request and tells the requester
 * nothing - they may ask again whenever they like. 404 when the request was
 * already answered or withdrawn, so a stale button cannot double-apply.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ requesterId: string }> }) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const { requesterId } = await params;
  if (!parsed.success || !/^[A-Za-z0-9_-]{1,128}$/.test(requesterId)) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  if (parsed.data.action === 'reject') {
    const result = await rejectFollowRequest(userId, requesterId);
    if (result === 'missing') return NextResponse.json({ error: 'social.requests.gone' }, { status: 404 });
    return NextResponse.json({ ok: true, action: 'reject' });
  }

  const result = await acceptFollowRequest(userId, requesterId);
  if (result === 'missing') return NextResponse.json({ error: 'social.requests.gone' }, { status: 404 });

  const me = await findUserById(userId);
  if (me) {
    await createNotification({
      userId: requesterId,
      type: NotificationType.FOLLOW_ACCEPTED,
      titleKey: 'notifications.followAccepted.title',
      bodyKey: 'notifications.followAccepted.body',
      params: { nickname: me.nickname },
      linkUrl: `/u/${me.nickname}`,
    }).catch((error) => console.error('[follow] accept notification failed', error));
  }

  return NextResponse.json({ ok: true, action: 'accept', followers: await followerCount(userId) });
}
