import { adminDb } from '../admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '../collections';
import { docToObject, docsToObjects } from '../convert';

/**
 * Direct messages - the reads. Every write is a transaction in
 * src/lib/messages/service.ts, which is also where the access rules live.
 *
 *   conversations/{a}__{b}             one thread per pair (ids sorted)
 *   conversations/{id}/messages/{id}   the messages
 *   users/{uid}/inbox/{peerId}         that user's row for the thread
 *   users/{uid}/blocks/{blockedId}     people that user blocked
 *
 * Every query here is an equality, a single-field range or a single-field
 * order - all served by Firestore's automatic indexes, none needing a
 * composite index deployed.
 */

/** 'ACTIVE' messages flow freely; REQUEST_IN awaits this user's answer; REQUEST_OUT awaits the other's. */
export type InboxState = 'ACTIVE' | 'REQUEST_IN' | 'REQUEST_OUT';

export type InboxRow = {
  /** = peerId: one row per person. */
  id: string;
  peerId: string;
  state: InboxState;
  unread: number;
  /** The latest message, cut to a preview. */
  lastBody: string;
  lastSenderId: string;
  lastMessageAt: Date;
};

export type PendingRequest = {
  /** Tags the request's messages, so rejecting deletes exactly those. */
  id: string;
  from: string;
  /** Messages sent while it waits; capped by MAX_REQUEST_MESSAGES. */
  count: number;
};

export type ConversationRecord = {
  id: string;
  participants: [string, string];
  /** The recipient accepted a request. Consent outlives the follow graph. */
  acceptedAt: Date | null;
  request: PendingRequest | null;
  createdAt: Date;
  lastMessageAt: Date;
};

export type MessageRecord = {
  id: string;
  senderId: string;
  body: string;
  createdAt: Date;
  /** The pending request this message belongs to, or null once delivered normally. */
  requestId: string | null;
  editedAt?: Date | null;
  deletedAt?: Date | null;
};

export function conversationId(a: string, b: string): string {
  return [a, b].sort().join('__');
}

const db = () => adminDb();
export const conversationRef = (id: string) => db().collection(COLLECTIONS.conversations).doc(id);
export const messagesOf = (id: string) => db().collection(SUBCOLLECTIONS.conversationMessages(id));
export const inboxRef = (userId: string, peerId: string) => db().collection(SUBCOLLECTIONS.userInbox(userId)).doc(peerId);
export const blockRef = (userId: string, blockedId: string) =>
  db().collection(SUBCOLLECTIONS.userBlocks(userId)).doc(blockedId);
export const followingRef = (userId: string, followeeId: string) =>
  db().collection(SUBCOLLECTIONS.userFollowing(userId)).doc(followeeId);

/** The inbox, most recent first. */
export async function listInbox(userId: string, take = 50): Promise<InboxRow[]> {
  const snap = await db()
    .collection(SUBCOLLECTIONS.userInbox(userId))
    .orderBy('lastMessageAt', 'desc')
    .limit(take)
    .get();
  return docsToObjects<InboxRow>(snap.docs) as InboxRow[];
}

/**
 * The badge: unread messages in open conversations, and message requests
 * waiting for an answer. Read by every live-notification poll, so it is two
 * cheap queries - a count aggregation and the (few) rows with anything unread.
 */
export async function inboxCounts(userId: string): Promise<{ unread: number; requests: number }> {
  const inbox = db().collection(SUBCOLLECTIONS.userInbox(userId));
  const [unreadRows, requests] = await Promise.all([
    inbox.where('unread', '>', 0).limit(100).get(),
    inbox.where('state', '==', 'REQUEST_IN').count().get(),
  ]);
  const unread = unreadRows.docs.reduce(
    (sum, doc) => (doc.get('state') === 'ACTIVE' ? sum + Number(doc.get('unread') ?? 0) : sum),
    0,
  );
  return { unread, requests: requests.data().count };
}

export async function getInboxRow(userId: string, peerId: string): Promise<InboxRow | null> {
  return docToObject<InboxRow>(await inboxRef(userId, peerId).get());
}

/** Clears the unread count; a no-op write is skipped. */
export async function markInboxRead(userId: string, peerId: string): Promise<void> {
  const row = await getInboxRow(userId, peerId);
  if (row && row.unread > 0) await inboxRef(userId, peerId).update({ unread: 0 });
}

/**
 * A page of messages, returned oldest first for display.
 *
 * `before`: the page that ends just before that instant (scrolling back).
 * `after`: everything newer than it (the open thread's poll).
 * Neither: the newest page.
 */
export async function listMessages(
  conversation: string,
  options: { before?: Date; after?: Date; take: number },
): Promise<MessageRecord[]> {
  let query = messagesOf(conversation) as FirebaseFirestore.Query;
  if (options.after) {
    query = query.where('createdAt', '>', options.after).orderBy('createdAt', 'asc');
    return docsToObjects<MessageRecord>((await query.limit(options.take).get()).docs) as MessageRecord[];
  }
  if (options.before) query = query.where('createdAt', '<', options.before);
  const snap = await query.orderBy('createdAt', 'desc').limit(options.take).get();
  return (docsToObjects<MessageRecord>(snap.docs) as MessageRecord[]).reverse();
}

/** Poll modifications separately so edits and deletions appear without reloading a thread. */
export async function listEditedMessages(conversation: string, after: Date, take: number): Promise<MessageRecord[]> {
  const snap = await messagesOf(conversation).where('editedAt', '>', after).orderBy('editedAt', 'asc').limit(take).get();
  return docsToObjects<MessageRecord>(snap.docs) as MessageRecord[];
}

export type BlockRecord = { id: string; blockedId: string; createdAt: Date };

export async function listBlocked(userId: string, take = 200): Promise<BlockRecord[]> {
  const snap = await db().collection(SUBCOLLECTIONS.userBlocks(userId)).limit(take).get();
  return (docsToObjects<BlockRecord>(snap.docs) as BlockRecord[]).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}
