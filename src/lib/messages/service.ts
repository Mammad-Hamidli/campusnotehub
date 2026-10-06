import { randomUUID } from 'node:crypto';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase/admin.core';
import { docToObject, forFirestore } from '@/lib/firebase/convert';
import {
  blockRef,
  conversationId,
  conversationRef,
  followingRef,
  inboxRef,
  messagesOf,
  type ConversationRecord,
  type InboxState,
  type MessageRecord,
  type PendingRequest,
} from '@/lib/firebase/repositories/messages';

/**
 * Direct messages: who may write to whom, enforced in one transaction per
 * action.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 * A message is delivered straight to the conversation when the two people
 * follow EACH OTHER, or when the recipient has already accepted a request
 * from this conversation. Otherwise it is a MESSAGE REQUEST: it waits in the
 * recipient's Requests until they
 *
 *   accept  - the conversation opens for good (consent, not the follow graph,
 *             is what keeps it open: unfollowing later does not shut it),
 *   reject  - the request's messages are deleted and it leaves both inboxes;
 *             like a follow request, the sender may ask again later,
 *   block   - as reject, and the sender can no longer message them at all.
 *
 * Replying to a request accepts it - writing back is consent. A conversation
 * that was open only because of a mutual follow (never accepted) goes back
 * to requests if either side unfollows: without mutual follows the rule asks
 * for the recipient's consent, and there was none.
 *
 * While a request waits, its sender may add up to MAX_REQUEST_MESSAGES
 * messages, so a request cannot be turned into a flood. Starting new requests
 * is rate-limited by the route ('messages:request').
 *
 * Blocks are checked first, in both directions, inside the same transaction
 * as the write, so a block that lands mid-send cannot be raced.
 */

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_REQUEST_MESSAGES = 3;
/** What the inbox row keeps of the latest message. */
const PREVIEW_LENGTH = 140;

export type ThreadState =
  /** Messages are delivered. */
  | 'OPEN'
  /** This viewer's request waits for the other person. */
  | 'REQUEST_OUT'
  /** The other person's request waits for this viewer. */
  | 'REQUEST_IN'
  /** Nothing pending and not open: the next message starts a request. */
  | 'CLOSED';

export type ThreadInfo = {
  state: ThreadState;
  conversation: ConversationRecord | null;
  mutual: boolean;
  /** The viewer blocked the other person. */
  blockedByMe: boolean;
  /** The other person blocked the viewer. Never shown as such - see the route. */
  blockedMe: boolean;
};

const conversationOf = (snap: DocumentSnapshot) => docToObject<ConversationRecord>(snap) as ConversationRecord | null;

function stateFor(viewerId: string, conversation: ConversationRecord | null, mutual: boolean): ThreadState {
  const request = conversation?.request;
  if (request?.from === viewerId) return 'REQUEST_OUT';
  if (request) return 'REQUEST_IN';
  return mutual || conversation?.acceptedAt ? 'OPEN' : 'CLOSED';
}

/** Where the viewer stands with `peerId`: five point reads in one round trip. */
export async function loadThread(viewerId: string, peerId: string): Promise<ThreadInfo> {
  const [conv, iBlocked, theyBlocked, iFollow, theyFollow] = await adminDb().getAll(
    conversationRef(conversationId(viewerId, peerId)),
    blockRef(viewerId, peerId),
    blockRef(peerId, viewerId),
    followingRef(viewerId, peerId),
    followingRef(peerId, viewerId),
  );
  const conversation = conversationOf(conv);
  const mutual = iFollow.exists && theyFollow.exists;
  return {
    state: stateFor(viewerId, conversation, mutual),
    conversation,
    mutual,
    blockedByMe: iBlocked.exists,
    blockedMe: theyBlocked.exists,
  };
}

export type SendResult =
  | { ok: true; message: MessageRecord; state: ThreadState; startedRequest: boolean }
  | {
      ok: false;
      /**
       * unavailable    - the recipient blocked the sender (reported vaguely on purpose)
       * you_blocked    - the sender blocked the recipient; unblock first
       * request_limit  - the sender's request already holds MAX_REQUEST_MESSAGES
       * request_needed - this would START a request and `allowNewRequest` was false
       */
      reason: 'unavailable' | 'you_blocked' | 'request_limit' | 'request_needed';
    };

/**
 * Sends one message, deciding in the same transaction whether it is
 * delivered or becomes (part of) a request, and updating both inbox rows.
 *
 * `allowNewRequest`: the route first calls with false; only when the answer
 * is `request_needed` does it spend the sender's daily request quota and call
 * again with true. A message in an open thread never touches that quota.
 */
export async function sendMessage(params: {
  senderId: string;
  recipientId: string;
  body: string;
  allowNewRequest: boolean;
  now?: Date;
}): Promise<SendResult> {
  const { senderId, recipientId, body } = params;
  const now = params.now ?? new Date();
  const id = conversationId(senderId, recipientId);
  const convRef = conversationRef(id);
  const messageRef = messagesOf(id).doc();

  return adminDb().runTransaction(async (tx) => {
    const [convSnap, theyBlocked, iBlocked, iFollow, theyFollow, theirRow] = await tx.getAll(
      convRef,
      blockRef(recipientId, senderId),
      blockRef(senderId, recipientId),
      followingRef(senderId, recipientId),
      followingRef(recipientId, senderId),
      inboxRef(recipientId, senderId),
    );
    if (theyBlocked.exists) return { ok: false, reason: 'unavailable' } as const;
    if (iBlocked.exists) return { ok: false, reason: 'you_blocked' } as const;

    const conversation = conversationOf(convSnap);
    const mutual = iFollow.exists && theyFollow.exists;
    let acceptedAt = conversation?.acceptedAt ?? null;
    let request: PendingRequest | null = conversation?.request ?? null;
    let startedRequest = false;

    // Writing back to someone's request is accepting it.
    if (!mutual && !acceptedAt && request?.from === recipientId) acceptedAt = now;
    const open = mutual || acceptedAt !== null;

    if (open) {
      request = null;
    } else if (request?.from === senderId) {
      if (request.count >= MAX_REQUEST_MESSAGES) return { ok: false, reason: 'request_limit' } as const;
      request = { ...request, count: request.count + 1 };
    } else {
      if (!params.allowNewRequest) return { ok: false, reason: 'request_needed' } as const;
      request = { id: randomUUID(), from: senderId, count: 1 };
      startedRequest = true;
    }

    const message = { senderId, body, createdAt: now, requestId: open ? null : request!.id };
    tx.create(messageRef, message);
    tx.set(
      convRef,
      forFirestore({
        participants: [senderId, recipientId].sort(),
        acceptedAt,
        request,
        createdAt: conversation?.createdAt ?? now,
        lastMessageAt: now,
        updatedAt: now,
      }),
    );

    const preview = { lastBody: body.slice(0, PREVIEW_LENGTH), lastSenderId: senderId, lastMessageAt: now, updatedAt: now };
    const mine: InboxState = open ? 'ACTIVE' : 'REQUEST_OUT';
    const theirs: InboxState = open ? 'ACTIVE' : 'REQUEST_IN';
    // Writing a message means the sender has seen the thread.
    tx.set(inboxRef(senderId, recipientId), { peerId: recipientId, state: mine, unread: 0, ...preview });
    tx.set(inboxRef(recipientId, senderId), {
      peerId: senderId,
      state: theirs,
      unread: Number(theirRow.get('unread') ?? 0) + 1,
      ...preview,
    });

    return {
      ok: true,
      message: { id: messageRef.id, ...message },
      state: open ? 'OPEN' : 'REQUEST_OUT',
      startedRequest,
    } as const;
  });
}

/**
 * Removes a pending request inside `tx`: its messages, both inbox rows, and
 * the conversation itself when nothing else was ever said in it. Earlier
 * history (a chat from when the two followed each other) is kept.
 *
 * Returns the writes to apply, because Firestore wants every read of a
 * transaction before its first write.
 */
async function dropRequest(
  tx: FirebaseFirestore.Transaction,
  conversation: ConversationRecord,
  userId: string,
  peerId: string,
): Promise<() => void> {
  const messages = messagesOf(conversation.id);
  const [requested, history] = await Promise.all([
    tx.get(messages.where('requestId', '==', conversation.request!.id)),
    tx.get(messages.where('requestId', '==', null).limit(1)),
  ]);
  return () => {
    for (const doc of requested.docs) tx.delete(doc.ref);
    tx.delete(inboxRef(userId, peerId));
    tx.delete(inboxRef(peerId, userId));
    if (history.empty) tx.delete(conversationRef(conversation.id));
    else tx.update(conversationRef(conversation.id), { request: null });
  };
}

/**
 * The recipient's answer to a message request. 'missing' when there is no
 * request from `peerId` any more (already answered, or withdrawn by a block),
 * so a stale button cannot double-apply.
 */
export async function respondToRequest(params: {
  userId: string;
  peerId: string;
  action: 'accept' | 'reject';
  now?: Date;
}): Promise<'accepted' | 'rejected' | 'missing'> {
  const { userId, peerId } = params;
  const now = params.now ?? new Date();
  const ref = conversationRef(conversationId(userId, peerId));

  return adminDb().runTransaction(async (tx) => {
    const conversation = conversationOf(await tx.get(ref));
    if (!conversation?.request || conversation.request.from !== peerId) return 'missing' as const;

    if (params.action === 'reject') {
      const apply = await dropRequest(tx, conversation, userId, peerId);
      apply();
      return 'rejected' as const;
    }

    const [mine, theirs] = await tx.getAll(inboxRef(userId, peerId), inboxRef(peerId, userId));
    tx.update(ref, { acceptedAt: now, request: null, updatedAt: now });
    // The request's messages become ordinary ones in place; their tag no
    // longer matches any request, so no later rejection can reach them.
    if (mine.exists) tx.update(mine.ref, { state: 'ACTIVE' });
    if (theirs.exists) tx.update(theirs.ref, { state: 'ACTIVE' });
    return 'accepted' as const;
  });
}

/**
 * Blocks `peerId` from messaging `userId`. Any pending request between them
 * is dropped as a rejection would drop it, and the thread leaves the
 * blocker's inbox. An open conversation stays visible to the blocked person -
 * they are not told about the block, their messages simply stop going
 * through. Idempotent.
 */
export async function blockUser(params: { userId: string; peerId: string; now?: Date }): Promise<void> {
  const { userId, peerId } = params;
  const now = params.now ?? new Date();
  const ref = conversationRef(conversationId(userId, peerId));

  await adminDb().runTransaction(async (tx) => {
    const conversation = conversationOf(await tx.get(ref));
    const apply = conversation?.request ? await dropRequest(tx, conversation, userId, peerId) : null;
    tx.set(blockRef(userId, peerId), { blockedId: peerId, createdAt: now });
    if (apply) apply();
    else tx.delete(inboxRef(userId, peerId));
  });
}

/** Lifts a block. The old thread reappears with the next message either way. */
export async function unblockUser(userId: string, peerId: string): Promise<void> {
  await blockRef(userId, peerId).delete();
}
