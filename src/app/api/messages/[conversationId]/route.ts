import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { requireMembership } from '@/lib/messages/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One conversation: read the thread, send into it, mark it read.
 *
 * Every handler begins with requireMembership(). That check is the entire
 * authorization model for messaging and it must stay first: a conversation id
 * is a cuid, but "unguessable" is not "authorized", and a thread is the most
 * private surface in the product.
 */

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Keyset cursor for older messages: `<iso>_<id>`. */
  before: z.string().optional(),
});

const MESSAGE_SELECT = {
  id: true,
  body: true,
  senderId: true,
  isDeleted: true,
  createdAt: true,
  editedAt: true,
} as const;

function serialize(
  row: {
    id: string;
    body: string;
    senderId: string;
    isDeleted: boolean;
    createdAt: Date;
    editedAt: Date | null;
  },
  viewerId: string,
) {
  return {
    id: row.id,
    // A deleted message keeps its row so the thread's shape survives, but the
    // text is withheld at the server rather than hidden by the client.
    body: row.isDeleted ? '' : row.body,
    isDeleted: row.isDeleted,
    fromMe: row.senderId === viewerId,
    senderId: row.senderId,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  };
}

async function session(request: NextRequest) {
  try {
    return { ok: true as const, ...(await requireSession(request)) };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        ok: false as const,
        response: NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 }),
      };
    }
    throw error;
  }
}

/** GET - the thread, oldest first, with the counterpart's public profile. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const auth = await session(request);
  if (!auth.ok) return auth.response;

  const membership = await requireMembership(conversationId, auth.userId);
  if (!membership) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { limit, before } = parsed.data;
  const [beforeTime, beforeId] = before ? before.split('_') : [];

  const [rows, other] = await Promise.all([
    db.message.findMany({
      where: {
        conversationId,
        ...(beforeTime && beforeId
          ? {
              OR: [
                { createdAt: { lt: new Date(beforeTime) } },
                { createdAt: new Date(beforeTime), id: { lt: beforeId } },
              ],
            }
          : {}),
      },
      // Newest-first for the query so the LIMIT takes the most recent page,
      // then reversed below - a thread is read oldest-first but paginated
      // backwards, and doing it the other way would fetch the whole history.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: MESSAGE_SELECT,
    }),
    db.conversationMember.findFirst({
      where: { conversationId, userId: { not: auth.userId } },
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
    }),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const oldest = page.at(-1);

  return NextResponse.json(
    {
      conversationId,
      participant: other?.user ?? null,
      messages: page.slice().reverse().map((m) => serialize(m, auth.userId)),
      nextCursor: hasMore && oldest ? `${oldest.createdAt.toISOString()}_${oldest.id}` : null,
      lastReadAt: membership.lastReadAt ? membership.lastReadAt.toISOString() : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const sendSchema = z.object({
  body: z.string().trim().min(1, 'errors.validationFailed').max(4000),
});

/** POST - send a message into the thread. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const auth = await session(request);
  if (!auth.ok) return auth.response;

  // A frozen account keeps read access to its own threads but cannot send -
  // that distinction comes from the capability table, not from a status check
  // written out again here.
  if (!can(auth.viewer, 'messages:send')) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  const membership = await requireMembership(conversationId, auth.userId);
  if (!membership) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const rate = await rateLimit('messages:send', {
    userId: auth.userId,
    ip: clientIp(request.headers),
  });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const now = new Date();

  const message = await db.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId, senderId: auth.userId, body: parsed.data.body },
      select: MESSAGE_SELECT,
    });

    // Both writes belong to the same transaction: an inbox ordered by a
    // lastMessageAt that did not advance would leave a new message buried at
    // the bottom of the list.
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: now },
    });

    // Sending is also reading: your own message must not come back to you as
    // unread the next time the inbox is counted.
    await tx.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: auth.userId } },
      data: { lastReadAt: now },
    });

    return created;
  });

  return NextResponse.json(
    { message: serialize(message, auth.userId) },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** PATCH - mark the thread read up to now. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const auth = await session(request);
  if (!auth.ok) return auth.response;

  const membership = await requireMembership(conversationId, auth.userId);
  if (!membership) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const now = new Date();
  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId: auth.userId } },
    data: { lastReadAt: now },
  });

  return NextResponse.json(
    { lastReadAt: now.toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
