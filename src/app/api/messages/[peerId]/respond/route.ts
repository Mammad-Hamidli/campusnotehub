import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, denialKey } from '@/lib/permissions';
import { blockUser, respondToRequest } from '@/lib/messages/service';
import { USER_ID } from '@/lib/messages/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ action: z.enum(['accept', 'reject', 'block']) });

/**
 * POST /api/messages/:peerId/respond { action: 'accept' | 'reject' | 'block' }
 * - the recipient's answer to a message request from :peerId.
 *
 * Only the recipient can answer: the conversation is derived from the
 * session's user and the path, and the request must be FROM the path's user.
 * 404 when there is no such request any more, so a stale button cannot
 * double-apply. Accepting opens a channel, so it needs 'messages:send';
 * rejecting and blocking only ever close one and are always allowed.
 *
 * `block` also works with no request pending (it is the same block as
 * PUT /api/me/blocks/:userId), so the Block button never fails on a race.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ peerId: string }> }) {
  let auth;
  try {
    auth = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const { peerId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !USER_ID.test(peerId) || peerId === auth.userId) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { action } = parsed.data;

  if (action === 'block') {
    await blockUser({ userId: auth.userId, peerId });
    return NextResponse.json({ ok: true, action });
  }
  if (action === 'accept' && !can(auth.viewer, 'messages:send')) {
    return NextResponse.json({ error: denialKey(auth.viewer, 'messages:send') }, { status: 403 });
  }

  const result = await respondToRequest({ userId: auth.userId, peerId, action });
  if (result === 'missing') {
    return NextResponse.json({ error: 'messages.errors.requestGone' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, action });
}
