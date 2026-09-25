import { adminDb } from '../admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '../collections';
import { docsToObjects, forFirestore } from '../convert';
import type { NotificationType } from '@/lib/enums';

/**
 * Notifications.
 *
 * Stored as locale KEYS plus parameters, never as rendered text - see
 * src/lib/notifications/dispatch.ts for why that matters on a trilingual
 * product. This module is only the storage; channel routing and the push
 * fan-out stay where they are.
 *
 * The security rules let a client read its OWN notifications directly, which
 * is the one collection where that is both safe and useful: the documents
 * contain no PII beyond the recipient's own id, and a live listener is how a
 * notification bell is meant to work.
 */

export type NotificationRecord = {
  id: string;
  userId: string;
  type: string;
  titleKey: string;
  bodyKey: string;
  params: Record<string, string | number> | null;
  linkUrl: string | null;
  readAt: Date | null;
  createdAt: Date;
};

const notifications = () => adminDb().collection(COLLECTIONS.notifications);

export async function createNotification(input: {
  userId: string;
  type: NotificationType | string;
  titleKey: string;
  bodyKey: string;
  params?: Record<string, string | number> | null;
  linkUrl?: string | null;
}): Promise<NotificationRecord> {
  const ref = notifications().doc();
  const record = {
    userId: input.userId,
    type: input.type as string,
    titleKey: input.titleKey,
    bodyKey: input.bodyKey,
    params: input.params ?? null,
    linkUrl: input.linkUrl ?? null,
    readAt: null,
    createdAt: new Date(),
  };
  await ref.set(forFirestore(record));
  return { id: ref.id, ...record };
}

/**
 * One page of a user's notifications, newest first.
 *
 * The composite index this needs (userId + createdAt desc) is declared in
 * firebase/firestore.indexes.json. Unread-only filtering is applied in memory
 * rather than as a third `where`, because `readAt == null` alongside the range
 * order would need yet another composite index for a list that is already
 * capped at one page.
 */
export async function listNotifications(
  userId: string,
  options: { limit?: number; before?: Date | null; after?: Date | null; unreadOnly?: boolean } = {},
): Promise<NotificationRecord[]> {
  const limit = options.limit ?? 30;

  let query: FirebaseFirestore.Query = notifications().where('userId', '==', userId);
  if (options.before) query = query.where('createdAt', '<', options.before);
  // Same (userId, createdAt desc) index: a range on the ordered field needs nothing new.
  if (options.after) query = query.where('createdAt', '>', options.after);

  const snap = await query.orderBy('createdAt', 'desc').limit(limit).get();
  const rows = docsToObjects<NotificationRecord>(snap.docs) as NotificationRecord[];

  return options.unreadOnly ? rows.filter((n) => n.readAt === null) : rows;
}

export async function countUnread(userId: string): Promise<number> {
  const snap = await notifications()
    .where('userId', '==', userId)
    .where('readAt', '==', null)
    .count()
    .get();
  return snap.data().count;
}

/**
 * Marks notifications read.
 *
 * The ids are verified to belong to the caller before any write. Firestore
 * would happily update a document by id alone, so the ownership check that SQL
 * expressed as `WHERE userId = :me` has to be explicit here - without it, a
 * caller could mark someone else's notifications read by guessing ids.
 */
export async function markRead(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const refs = ids.slice(0, 400).map((id) => notifications().doc(id));
  const snaps = await adminDb().getAll(...refs);

  const now = new Date();
  const batch = adminDb().batch();
  let marked = 0;

  for (const snap of snaps) {
    const data = snap.data();
    if (!snap.exists || data?.userId !== userId || data?.readAt) continue;
    batch.update(snap.ref, forFirestore({ readAt: now }));
    marked++;
  }

  if (marked > 0) await batch.commit();
  return marked;
}

/** Marks every unread notification read. Chunked to respect the batch cap. */
export async function markAllRead(userId: string): Promise<number> {
  const snap = await notifications()
    .where('userId', '==', userId)
    .where('readAt', '==', null)
    .get();
  if (snap.empty) return 0;

  const now = new Date();
  let written = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = adminDb().batch();
    for (const doc of snap.docs.slice(i, i + 400)) {
      batch.update(doc.ref, forFirestore({ readAt: now }));
    }
    await batch.commit();
    written += Math.min(400, snap.docs.length - i);
  }
  return written;
}

// ---------------------------------------------------------------------------

export type NotificationPreference = { channel: string; enabled: boolean; type: string };

/**
 * A user's per-type channel preferences, read from their own subcollection.
 *
 * Returns an empty list when nothing has been set, which channelsFor() treats
 * as "everything enabled" - the same default the SQL version had when no row
 * existed.
 */
export async function notificationPreferences(
  userId: string,
  type?: string,
): Promise<NotificationPreference[]> {
  let query: FirebaseFirestore.Query = adminDb().collection(SUBCOLLECTIONS.notifPrefs(userId));
  if (type) query = query.where('type', '==', type);

  const snap = await query.get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      channel: String(data.channel ?? ''),
      enabled: data.enabled !== false,
      type: String(data.type ?? ''),
    };
  });
}

export async function setNotificationPreference(
  userId: string,
  type: string,
  channel: string,
  enabled: boolean,
): Promise<void> {
  // Keyed by type+channel so a preference cannot be recorded twice - the
  // structural stand-in for the SQL unique constraint on (userId, type,
  // channel).
  await adminDb()
    .collection(SUBCOLLECTIONS.notifPrefs(userId))
    .doc(`${type}__${channel}`)
    .set(forFirestore({ type, channel, enabled }), { merge: true });
}
