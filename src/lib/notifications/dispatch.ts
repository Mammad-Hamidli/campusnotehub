import type { NotificationType, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { getRedis } from '@/lib/queue/connection';

// Lazily constructed - see src/lib/queue/connection.ts for why nothing here
// may open a socket at module scope.
let queue: Queue | null = null;
export function getNotificationQueue(): Queue {
  queue ??= new Queue('notifications', { connection: getRedis() });
  return queue;
}

export type NotificationInput = {
  userId: string;
  type: NotificationType;
  /** Locale KEYS, never rendered strings - see below. */
  titleKey: string;
  bodyKey: string;
  params?: Record<string, string | number>;
  linkUrl?: string;
};

/**
 * Notifications are stored as locale keys plus parameters, never as rendered
 * text.
 *
 * This is a deliberate departure from the usual "store the message" approach
 * and it is worth the extra indirection on a trilingual product: a student who
 * signs up in Azerbaijani, receives ten notifications, then switches the
 * header to English would otherwise be left with a permanently mixed-language
 * notification list. Rendering at read time means the whole history switches
 * language with the toggle.
 *
 * The cost is that changing a message wording retroactively rewrites history.
 * That is the right trade here - these are transactional notices, not a record
 * of what was said to whom.
 */
export async function enqueueNotification(
  tx: Prisma.TransactionClient,
  input: NotificationInput,
) {
  const row = await tx.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      titleKey: input.titleKey,
      bodyKey: input.bodyKey,
      params: input.params as Prisma.InputJsonValue,
      linkUrl: input.linkUrl,
    },
  });

  // Enqueued after the DB row so the fan-out worker can never deliver a push
  // for a notification the transaction later rolled back.
  void getNotificationQueue().add(
    'fanout',
    { notificationId: row.id },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
    },
  );

  return row;
}

/**
 * Channel routing. In-app is always written. Web push and email are opt-out
 * per type, with two hard rules that override preferences:
 *
 *   - security notices (verification outcome, new device login) always send
 *   - a session reminder inside the last hour always sends, because a missed
 *     paid session is a refund and a support ticket
 */
export function channelsFor(
  type: NotificationType,
  prefs: { channel: string; enabled: boolean }[],
): ('WEB_PUSH' | 'EMAIL')[] {
  const FORCED: NotificationType[] = [
    'VERIFICATION_APPROVED',
    'VERIFICATION_REJECTED',
    'VERIFICATION_NEEDS_REVIEW',
    'BOOKING_REMINDER_1H',
    'BOOKING_CANCELLED',
  ];
  if (FORCED.includes(type)) return ['WEB_PUSH', 'EMAIL'];

  const enabled = (c: string) => prefs.find((p) => p.channel === c)?.enabled ?? true;
  const out: ('WEB_PUSH' | 'EMAIL')[] = [];
  if (enabled('WEB_PUSH')) out.push('WEB_PUSH');
  // Email is opt-in for social noise; nobody wants mail for every like.
  const SOCIAL: NotificationType[] = ['POST_LIKE', 'POST_REPLY', 'NEW_FOLLOWER'];
  if (enabled('EMAIL') && !SOCIAL.includes(type)) out.push('EMAIL');
  return out;
}
