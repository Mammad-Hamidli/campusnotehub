import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { countUnread, listNotifications } from '@/lib/firebase/repositories/notifications';
import { countIncomingRequests } from '@/lib/firebase/repositories/followRequests';
import { serializeNotification } from '@/lib/notifications/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A client clock far ahead of ours must not hide everything; nor may a stale one refetch history. */
const MAX_LOOKBACK_MS = 10 * 60_000;

/**
 * GET /api/notifications/live?since=<iso>
 *   -> { unreadCount, followRequests, latest: Notification[], serverTime }
 *
 * The heartbeat behind the live bell (LiveNotificationsProvider): the unread
 * badge, the pending follow-request count, and any notification newer than
 * `since` - likes, comments, follow requests - for the client to toast.
 *
 * ---------------------------------------------------------------------------
 * WHY A SHORT POLL AND NOT A STREAM
 * ---------------------------------------------------------------------------
 * Auth is custom (not Firebase Auth), so browsers cannot hold a Firestore
 * listener, and a Server-Sent Events route on Vercel keeps one function
 * instance busy per open tab until its timeout, then reconnects - paying for
 * idle connections and dropping events at each cut. This answers in one
 * round trip for three cheap reads (two count aggregations and a bounded
 * range query on the existing userId+createdAt index), and the client only
 * polls while the tab is visible. The next `since` is derived from
 * `serverTime` (with a small overlap the client de-duplicates by id), so
 * client clock skew never loses a notification.
 */
export async function GET(request: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request, { passive: true }));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const now = new Date();
  const raw = request.nextUrl.searchParams.get('since');
  const parsed = raw ? new Date(raw) : null;
  const floor = new Date(now.getTime() - MAX_LOOKBACK_MS);
  const since = parsed && !Number.isNaN(parsed.getTime()) ? (parsed < floor ? floor : parsed) : null;

  const [unreadCount, followRequests, latest] = await Promise.all([
    countUnread(userId),
    countIncomingRequests(userId),
    since
      ? listNotifications(userId, { after: since, limit: 10 }).catch((error) => {
          // A missing index must cost the toasts, not the badge.
          console.error('[notifications/live] latest query failed', error);
          return [];
        })
      : Promise.resolve([]),
  ]);

  return NextResponse.json(
    {
      unreadCount,
      followRequests,
      latest: latest.map(serializeNotification),
      serverTime: now.toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
