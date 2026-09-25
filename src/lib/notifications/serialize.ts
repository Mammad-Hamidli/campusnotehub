import type { NotificationRecord } from '@/lib/firebase/repositories/notifications';

/** The wire shape of a notification, shared by the list and the live poll. */
export function serializeNotification(row: NotificationRecord) {
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

export type SerializedNotification = ReturnType<typeof serializeNotification>;
