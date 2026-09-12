import type { DocumentReference, Transaction, WriteBatch } from 'firebase-admin/firestore';
import type { NotificationType } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { forFirestore } from '@/lib/firebase/convert';
import { createNotification } from '@/lib/firebase/repositories/notifications';
import { findUserById } from '@/lib/firebase/repositories/users';
import { sendEmailAsync } from '@/lib/email/send';
import { DEFAULT_LOCALE, DICTIONARIES, isLocale, translate } from '@/lib/i18n/dictionaries';

export type NotificationInput = {
  userId: string;
  type: NotificationType;
  /** Locale KEYS, never rendered strings - see below. */
  titleKey: string;
  bodyKey: string;
  params?: Record<string, string | number>;
  linkUrl?: string;
  /** Set when the caller sends a dedicated email for the same event. */
  skipEmail?: boolean;
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
 *
 * ===========================================================================
 * THE QUEUE IS GONE, AND THE IN-APP ROW IS WHAT WAS ALWAYS LOAD-BEARING
 * ===========================================================================
 * This used to write the row and then push a `fanout` job onto a BullMQ queue
 * backed by Redis, for a worker (src/server/queue/notifications.worker.ts) to
 * pick up and deliver web push and email. That worker did not exist - the
 * package.json script pointed at a file that was never written - so every job
 * ever enqueued sat in Redis unconsumed.
 *
 * With Redis removed, the durable in-app notification is written directly and
 * nothing is enqueued. That is not a reduction in delivered behaviour: it is
 * the same behaviour, minus a queue that fed nothing.
 *
 * Push and email fan-out, when it is built, belongs in a Cloud Function
 * triggered on document creation in `notifications` - which is the Firebase
 * shape of exactly what the worker was going to do, and needs no broker.
 * channelsFor() below is kept intact for that consumer.
 */
export async function enqueueNotification(input: NotificationInput) {
  const record = await createNotification({
    userId: input.userId,
    type: input.type,
    titleKey: input.titleKey,
    bodyKey: input.bodyKey,
    params: input.params ?? null,
    linkUrl: input.linkUrl ?? null,
  });
  if (!input.skipEmail) emailNotification(input);
  return record;
}

/**
 * The same write, inside a caller's atomic unit.
 *
 * Callers that notify as part of a larger change - a moderator's verdict, a
 * booking, a graduation sweep - need the notification to commit with it, or
 * not at all. A user told "you are verified" by a write that then rolled back
 * is worse than no notification.
 *
 * Accepts a Transaction OR a WriteBatch, because both are atomic and the
 * choice between them is the caller's: a batch when the writes depend on
 * nothing that must be read under conflict detection, a transaction when they
 * do. Both expose the same `set`, so this helper does not need to care.
 *
 * Issues no reads, so it is safe to call at any point after a transaction's
 * final read. Returns the id rather than the record, because nothing has
 * committed yet and handing back a "created" object would be a lie.
 */
type AtomicWriter = {
  set(ref: DocumentReference, data: FirebaseFirestore.DocumentData): unknown;
};

export function enqueueNotificationTx(
  tx: AtomicWriter | Transaction | WriteBatch,
  input: NotificationInput,
): string {
  const ref = adminDb().collection(COLLECTIONS.notifications).doc();
  (tx as AtomicWriter).set(
    ref,
    forFirestore({
      userId: input.userId,
      type: input.type,
      titleKey: input.titleKey,
      bodyKey: input.bodyKey,
      params: input.params ?? null,
      linkUrl: input.linkUrl ?? null,
      readAt: null,
      createdAt: new Date(),
    }),
  );
  return ref.id;
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

/**
 * Notification types that already send their own dedicated email, and social
 * noise that is never emailed (see channelsFor above). Everything else gets a
 * "new notification" email in the recipient's language.
 */
const DEDICATED_EMAIL: ReadonlySet<string> = new Set([
  'VERIFICATION_APPROVED',
  'VERIFICATION_REJECTED',
  'VERIFICATION_NEEDS_REVIEW',
  'NOTE_SOLD',
  'NOTE_MODERATION',
  'WALLET_CREDIT',
]);
const SOCIAL: ReadonlySet<string> = new Set(['POST_LIKE', 'POST_REPLY', 'NEW_FOLLOWER']);

/** Fire-and-forget: a mail problem never fails the notification. */
function emailNotification(input: NotificationInput): void {
  if (DEDICATED_EMAIL.has(input.type) || SOCIAL.has(input.type)) return;
  void (async () => {
    const user = await findUserById(input.userId);
    if (!user || user.deletedAt) return;
    const dictionary = DICTIONARIES[isLocale(user.locale) ? user.locale : DEFAULT_LOCALE];
    sendEmailAsync(user.email, 'newNotification', {
      nickname: user.nickname,
      title: translate(dictionary, input.titleKey, input.params),
      body: translate(dictionary, input.bodyKey, input.params),
      linkUrl: input.linkUrl ?? '/notifications',
    });
  })().catch((error) => console.error('[notifications] email failed', error));
}
