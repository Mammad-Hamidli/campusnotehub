import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { openConversation } from '@/lib/messages/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/messages          - the inbox (conversation list)
 * POST /api/messages          - open (or reuse) a thread with someone
 *
 * The individual thread lives at /api/messages/[conversationId].
 */

/**
 * The inbox.
 *
 * Ordered by the denormalised `lastMessageAt` on the conversation rather than
 * by an aggregate over messages. Sorting an inbox by MAX(messages.createdAt)
 * means touching every message in every thread on every load - the classic
 * query that is instant with three test threads and unusable with three
 * hundred.
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

  const memberships = await db.conversationMember.findMany({
    where: { userId, archivedAt: null },
    select: {
      lastReadAt: true,
      conversation: {
        select: {
          id: true,
          lastMessageAt: true,
          members: {
            where: { userId: { not: userId } },
            select: {
              user: {
                select: {
                  id: true,
                  nickname: true,
                  avatarUrl: true,
                  isVerified: true,
                  headline: true,
                  university: { select: { code: true } },
                },
              },
            },
          },
          // Only the newest message, for the preview line. `take: 1` on an
          // ordered relation is a lateral join, not a full load of the thread.
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, body: true, senderId: true, createdAt: true, isDeleted: true },
          },
        },
      },
    },
    orderBy: { conversation: { lastMessageAt: 'desc' } },
    take: 100,
  });

  /**
   * Unread counts, in ONE grouped query rather than one per thread.
   *
   * Prisma cannot express "count messages after this member's own cursor"
   * across rows in a single groupBy, so the cursors are applied afterwards
   * against a per-conversation tally. Threads the viewer has never opened have
   * a null cursor and count everything the other side sent.
   */
  const conversationIds = memberships.map((m) => m.conversation.id);

  const unreadRows = conversationIds.length
    ? await db.message.groupBy({
        by: ['conversationId'],
        where: {
          conversationId: { in: conversationIds },
          // Your own messages are never unread to you.
          senderId: { not: userId },
          isDeleted: false,
          OR: memberships.map((m) => ({
            conversationId: m.conversation.id,
            ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
          })),
        },
        _count: { _all: true },
      })
    : [];

  const unreadByConversation = new Map(unreadRows.map((r) => [r.conversationId, r._count._all]));

  const conversations = memberships.map((m) => {
    const other = m.conversation.members[0]?.user ?? null;
    const last = m.conversation.messages[0] ?? null;
    return {
      id: m.conversation.id,
      // Null when the counterpart's account was deleted. The client renders a
      // tombstone rather than crashing, and the history stays readable.
      participant: other,
      lastMessage: last
        ? {
            id: last.id,
            body: last.isDeleted ? '' : last.body,
            isDeleted: last.isDeleted,
            fromMe: last.senderId === userId,
            createdAt: last.createdAt.toISOString(),
          }
        : null,
      lastMessageAt: m.conversation.lastMessageAt.toISOString(),
      unreadCount: unreadByConversation.get(m.conversation.id) ?? 0,
    };
  });

  return NextResponse.json(
    {
      conversations,
      unreadTotal: conversations.reduce((sum, c) => sum + c.unreadCount, 0),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const openSchema = z.object({
  /** The other participant. */
  userId: z.string().cuid(),
});

/**
 * POST /api/messages - open a thread.
 *
 * Idempotent: calling it twice returns the same conversation id, which is what
 * makes "Message" safe to press repeatedly. See openConversation() for how the
 * race is resolved by the database rather than by application ordering.
 */
export async function POST(request: NextRequest) {
  let userId: string;
  let viewer;
  try {
    ({ userId, viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  if (!can(viewer, 'messages:send')) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  const parsed = openSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  if (parsed.data.userId === userId) {
    return NextResponse.json({ error: 'messages.errors.cannotMessageSelf' }, { status: 400 });
  }

  // The counterpart must be a real, live account. Without this check the
  // endpoint would happily create a thread against any cuid, which is both a
  // junk-row generator and a way to probe which ids exist.
  const other = await db.user.findFirst({
    where: {
      id: parsed.data.userId,
      deletedAt: null,
      accountStatus: { in: ['ACTIVE', 'RESTRICTED'] },
    },
    select: { id: true },
  });
  if (!other) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const conversationId = await openConversation(userId, other.id);

  return NextResponse.json({ conversationId }, { headers: { 'Cache-Control': 'no-store' } });
}
