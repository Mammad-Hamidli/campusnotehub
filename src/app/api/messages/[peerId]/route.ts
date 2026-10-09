import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, denialKey } from '@/lib/permissions';
import { findUserById } from '@/lib/firebase/repositories/users';
import { listEditedMessages, listMessages, markInboxRead } from '@/lib/firebase/repositories/messages';
import { deleteSentMessage, editSentMessage, loadThread, MAX_MESSAGE_LENGTH, MAX_REQUEST_MESSAGES, sendMessage } from '@/lib/messages/service';
import { chatMessage, chatPeer, isMessageable, USER_ID } from '@/lib/messages/serialize';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { visibilityRelationshipsFor } from '@/lib/profile/visibility.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE = 30;
/** One poll can catch up on this many; a longer gap reloads the page instead. */
const CATCH_UP = 100;

async function authenticate(request: NextRequest, passive = false) {
  try {
    return await requireSession(request, { passive });
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

const unauthorized = () => NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
const unavailable = () => NextResponse.json({ error: 'messages.errors.unavailable' }, { status: 404 });

function instant(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * GET /api/messages/:peerId?before=<iso>|after=<iso> - one conversation.
 *
 *   -> { peer, state, canSend, reason, asRequest, requestRoom, messages, hasMore }
 *
 * `state` is where the viewer stands: OPEN, REQUEST_OUT (their request
 * waits), REQUEST_IN (they have a request to answer) or CLOSED (the next
 * message starts a request). `asRequest` says the next message will wait for
 * the other person's consent; `canSend` false comes with the `reason` key.
 * A block by the OTHER person reads as "unavailable", never as a block.
 *
 * No cursor: the newest page. `before`: the page before it. `after`: what
 * arrived since - the open thread polls this, with the passive header, every
 * few seconds while visible. Loading the thread marks it read.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ peerId: string }> }) {
  const auth = await authenticate(request, request.headers.has('x-session-passive'));
  if (!auth) return unauthorized();
  const { peerId } = await params;
  if (!USER_ID.test(peerId)) return unavailable();

  const peer = await findUserById(peerId);
  if (!isMessageable(peer, auth.userId)) return unavailable();

  const before = instant(request.nextUrl.searchParams.get('before'));
  const after = before ? undefined : instant(request.nextUrl.searchParams.get('after'));
  const thread = await loadThread(auth.userId, peerId);
  const take = after ? CATCH_UP : PAGE;
  let messages = thread.conversation ? await listMessages(thread.conversation.id, { before, after, take }) : [];
  if (after && thread.conversation) {
    const byId = new Map(messages.map((message) => [message.id, message]));
    for (const message of await listEditedMessages(thread.conversation.id, after, CATCH_UP)) byId.set(message.id, message);
    messages = [...byId.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // Read once the reader has the messages: on open, and when a poll brings theirs.
  if (!before && thread.conversation && (!after || messages.some((m) => m.senderId === peerId))) {
    await markInboxRead(auth.userId, peerId);
  }

  const pending = thread.conversation?.request;
  const requestRoom = pending?.from === auth.userId ? MAX_REQUEST_MESSAGES - pending.count : MAX_REQUEST_MESSAGES;
  const reason = thread.blockedByMe
    ? 'messages.errors.youBlocked'
    : thread.blockedMe
      ? 'messages.errors.unavailable'
      : !can(auth.viewer, 'messages:send')
        ? denialKey(auth.viewer, 'messages:send')
        : thread.state === 'REQUEST_OUT' && requestRoom <= 0
          ? 'messages.errors.requestLimit'
          : null;

  return NextResponse.json(
    {
      peer: chatPeer(peer, auth.viewer, (await visibilityRelationshipsFor([peer.id], auth.viewer)).get(peer.id)),
      state: thread.state,
      canSend: reason === null,
      reason,
      asRequest: thread.state === 'CLOSED' || thread.state === 'REQUEST_OUT',
      requestRoom,
      blockedByMe: thread.blockedByMe,
      messages: messages.map((message) => chatMessage(message, auth.userId)),
      hasMore: !after && messages.length === PAGE,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const sendSchema = z.object({
  body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

const SEND_ERRORS = {
  unavailable: { error: 'messages.errors.unavailable', status: 403 },
  you_blocked: { error: 'messages.errors.youBlocked', status: 409 },
  request_limit: { error: 'messages.errors.requestLimit', status: 429 },
} as const;

/**
 * POST /api/messages/:peerId { body } - sends a message.
 *
 * Delivered when the two follow each other or the conversation was accepted;
 * otherwise it is (or adds to) a message request - see
 * src/lib/messages/service.ts. Only STARTING a request spends the daily
 * 'messages:request' quota, so the service is asked first without permission
 * to start one, and again with it only when that is what this message does.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ peerId: string }> }) {
  const auth = await authenticate(request);
  if (!auth) return unauthorized();
  if (!can(auth.viewer, 'messages:send')) {
    return NextResponse.json({ error: denialKey(auth.viewer, 'messages:send') }, { status: 403 });
  }

  const { peerId } = await params;
  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'messages.errors.invalid' }, { status: 400 });
  if (!USER_ID.test(peerId)) return unavailable();

  const peer = await findUserById(peerId);
  if (!isMessageable(peer, auth.userId)) return unavailable();

  const rate = await rateLimit('messages:send', { userId: auth.userId, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const send = (allowNewRequest: boolean) =>
    sendMessage({ senderId: auth.userId, recipientId: peerId, body: parsed.data.body, allowNewRequest });

  let result = await send(false);
  if (!result.ok && result.reason === 'request_needed') {
    const quota = await rateLimit('messages:request', { userId: auth.userId, ip: clientIp(request.headers) });
    if (!quota.ok) return NextResponse.json({ error: 'messages.errors.requestQuota' }, { status: 429 });
    result = await send(true);
  }
  if (!result.ok) {
    // request_needed cannot repeat with permission granted; treat it as the race it would be.
    const failure = result.reason === 'request_needed' ? SEND_ERRORS.request_limit : SEND_ERRORS[result.reason];
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }

  return NextResponse.json(
    { message: chatMessage(result.message, auth.userId), state: result.state },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}

const editSchema = z.object({ messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) });
const messageIdSchema = z.object({ messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** PATCH /api/messages/:peerId edits only the sender's most recent message. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ peerId: string }> }) {
  const auth = await authenticate(request);
  if (!auth) return unauthorized();
  if (!can(auth.viewer, 'messages:send')) return NextResponse.json({ error: denialKey(auth.viewer, 'messages:send') }, { status: 403 });
  const { peerId } = await params;
  const parsed = editSchema.safeParse(await request.json().catch(() => null));
  if (!USER_ID.test(peerId) || !parsed.success) return unavailable();
  const peer = await findUserById(peerId);
  if (!isMessageable(peer, auth.userId)) return unavailable();
  const changed = await editSentMessage({ senderId: auth.userId, recipientId: peerId, ...parsed.data });
  return changed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'messages.errors.editLatestOnly' }, { status: 409 });
}

/** DELETE /api/messages/:peerId removes any message authored by the caller. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ peerId: string }> }) {
  const auth = await authenticate(request);
  if (!auth) return unauthorized();
  if (!can(auth.viewer, 'messages:send')) return NextResponse.json({ error: denialKey(auth.viewer, 'messages:send') }, { status: 403 });
  const { peerId } = await params;
  const parsed = messageIdSchema.safeParse(await request.json().catch(() => null));
  if (!USER_ID.test(peerId) || !parsed.success) return unavailable();
  const peer = await findUserById(peerId);
  if (!isMessageable(peer, auth.userId)) return unavailable();
  const deleted = await deleteSentMessage({ senderId: auth.userId, recipientId: peerId, messageId: parsed.data.messageId });
  return deleted ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'messages.errors.messageNotFound' }, { status: 404 });
}
