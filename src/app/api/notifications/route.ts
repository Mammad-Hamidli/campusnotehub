import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
} from '@/lib/firebase/repositories/notifications';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The notification list.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE REAL EVENTS, NOT A DEMO LIST
 * ---------------------------------------------------------------------------
 * Rows come from the `notifications` table, which is written by the code paths
 * that actually happen: a comment on your post, a like, a verification
 * decision, an admin action against your account. Nothing here invents a
 * notification, and there is deliberately no seeded placeholder - an empty
 * list is the truth about a new account and rendering fiction into it is how a
 * "feature" that never worked comes to look finished.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROWS ARE KEYS AND PARAMETERS RATHER THAN SENTENCES
 * ---------------------------------------------------------------------------
 * This is the existing convention from src/lib/notifications/dispatch.ts and
 * it is preserved here: a row stores `titleKey`, `bodyKey` and `params`, and
 * the CLIENT renders them through the active locale. On a trilingual product,
 * storing rendered text would leave a student who switches language with a
 * permanently mixed-language history.
 */

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().optional(),
  /** `unread` narrows to the badge's contents. */
  filter: z.enum(['all', 'unread']).default('all'),
});

function serialize(row: {
  id: string;
  type: string;
  titleKey: string;
  bodyKey: string;
  params: unknown;
  linkUrl: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    titleKey: row.titleKey,
    bodyKey: row.bodyKey,
    // Always an object, never null: the client interpolates into it, and a
    // null here would mean every consumer needs its own guard.
    params: (row.params ?? {}) as Record<string, string | number>,
    linkUrl: row.linkUrl,
    read: row.readAt !== null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /api/notifications */
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

  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { limit, cursor, filter } = parsed.data;

  const [cursorTime] = cursor ? cursor.split('_') : [];

  /**
   * Keyset pagination on createdAt DESC, matching the composite index declared
   * in firebase/firestore.indexes.json.
   *
   * The SQL cursor was a (createdAt, id) TUPLE, which needed the `OR` above to
   * break ties on identical timestamps. Firestore has no cross-field `OR`, so
   * the cursor is the timestamp alone. The tie-break it gives up only matters
   * for two notifications written in the same millisecond to the same user,
   * where the loser would be skipped - and the id is still emitted in the
   * cursor so a future startAfter() can restore the exact tuple without
   * changing the wire format.
   */
  const [rows, unreadCount] = await Promise.all([
    listNotifications(userId, {
      limit: limit + 1,
      before: cursorTime ? new Date(cursorTime) : null,
      unreadOnly: filter === 'unread',
    }),
    countUnread(userId),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return NextResponse.json(
    {
      notifications: page.map(serialize),
      unreadCount,
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const patchSchema = z.discriminatedUnion('op', [
  // Firestore document ids, not cuids: `.cuid()` here would reject every id
  // the application itself minted. The ownership check in markRead() is what
  // actually protects this endpoint; the shape check only bounds the input.
  z.object({
    op: z.literal('read'),
    ids: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
  }),
  z.object({ op: z.literal('readAll') }),
]);

/**
 * PATCH /api/notifications - mark read.
 *
 * Both operations scope their WHERE to the caller's own userId. That is the
 * whole authorization story and it must stay in the WHERE clause rather than
 * in a preceding ownership check: an id list supplied by the client would
 * otherwise let anyone mark a stranger's notifications read, which is a
 * denial-of-service against someone else's inbox.
 */
export async function PATCH(request: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  /**
   * Both repository functions scope to the caller's own userId internally, and
   * markRead() re-reads each id to confirm ownership before writing. That
   * check is not optional here: Firestore updates a document by id alone, so
   * the `WHERE userId = :me` the SQL carried has to be performed explicitly or
   * a client could mark a stranger's inbox read by guessing ids.
   *
   * Already-read rows keep their original timestamp in both paths.
   */
  const updated =
    parsed.data.op === 'read'
      ? await markRead(userId, parsed.data.ids)
      : await markAllRead(userId);

  const unreadCount = await countUnread(userId);

  return NextResponse.json(
    { updated, unreadCount },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
