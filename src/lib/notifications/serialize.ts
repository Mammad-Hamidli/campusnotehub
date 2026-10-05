import type { NotificationRecord } from '@/lib/firebase/repositories/notifications';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';

/**
 * Rows written before session requests existed (b06abd3) link to /bookings,
 * which no longer exists. They are all a mentor's BOOKING_REQUESTED rows and
 * carry no booking id, so they open the mentor panel's request list, where a
 * request still waiting can be answered. Rewritten here, on read, so stored
 * rows need no migration.
 */
const LEGACY_BOOKINGS_LINK = /^\/bookings(?:[/?#]|$)/;

function linkFor(linkUrl: string | null): string | null {
  return linkUrl && LEGACY_BOOKINGS_LINK.test(linkUrl) ? `${MENTOR_DASHBOARD_PATH}#requests` : linkUrl;
}

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
    linkUrl: linkFor(row.linkUrl),
    read: row.readAt !== null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type SerializedNotification = ReturnType<typeof serializeNotification>;
