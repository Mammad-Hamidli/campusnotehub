import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { listInbox } from '@/lib/firebase/repositories/messages';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { chatPeer } from '@/lib/messages/serialize';
import { isPubliclyVisible } from '@/lib/profile/visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/messages - the viewer's conversations, most recent first: open
 * ones and requests in both directions, each with the other person, the
 * state, the unread count and a preview of the latest message.
 *
 * A conversation whose other person can no longer be shown (deleted,
 * suspended, banned) is left out rather than listed as "@unknown".
 *
 * Polled by the open messages panel, so it honours the passive header
 * (x-session-passive, set by the client - see SessionKeeper) and does not
 * count as activity.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireSession(request, { passive: request.headers.has('x-session-passive') });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const rows = await listInbox(auth.userId);
  const people = await findUsersByIds(rows.map((row) => row.peerId));

  const conversations = rows.flatMap((row) => {
    const peer = people.get(row.peerId);
    if (!isPubliclyVisible(peer)) return [];
    return [
      {
        peer: chatPeer(peer, auth.viewer),
        state: row.state,
        unread: row.unread,
        lastMessage: {
          body: row.lastBody,
          fromMe: row.lastSenderId === auth.userId,
          createdAt: row.lastMessageAt.toISOString(),
        },
      },
    ];
  });

  return NextResponse.json({ conversations }, { headers: { 'Cache-Control': 'no-store' } });
}
