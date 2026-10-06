import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findUserById } from '@/lib/firebase/repositories/users';
import { blockUser, unblockUser } from '@/lib/messages/service';
import { USER_ID } from '@/lib/messages/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT    /api/me/blocks/:userId - block that person from messaging the viewer
 * DELETE /api/me/blocks/:userId - lift the block
 *
 * Both idempotent. Blocking drops any pending message request between the two
 * (see blockUser); unblocking restores nothing by itself - the conversation
 * comes back with the next message.
 */
async function handle(request: NextRequest, userIdParam: string, block: boolean) {
  let auth;
  try {
    auth = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  if (!USER_ID.test(userIdParam) || userIdParam === auth.userId) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  if (block) {
    if (!(await findUserById(userIdParam))) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
    await blockUser({ userId: auth.userId, peerId: userIdParam });
  } else {
    await unblockUser(auth.userId, userIdParam);
  }
  return NextResponse.json({ ok: true, blocked: block }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  return handle(request, (await params).userId, true);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  return handle(request, (await params).userId, false);
}
