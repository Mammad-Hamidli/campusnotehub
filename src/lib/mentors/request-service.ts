import type { Transaction } from 'firebase-admin/firestore';
import { BookingStatus, NotificationType } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { docToObject, docsToObjects, forFirestore } from '@/lib/firebase/convert';
import {
  bookingsOverlapping,
  mentorCollections,
  type BookingRecord,
} from '@/lib/firebase/repositories/mentors';
import { scheduleTx, unscheduleTx } from '@/lib/firebase/repositories/scheduledTasks';
import { findCalendarLink } from '@/lib/firebase/repositories/calendarLinks';
import { findUserById } from '@/lib/firebase/repositories/users';
import { enqueueNotificationTx } from '@/lib/notifications/dispatch';
import { sendEmail } from '@/lib/email/send';
import { afterResponse } from '@/lib/after-response';
import { BookingError } from './availability';
import { formatEmailTime } from './email-time';
import { bookingIdFor } from './ids';
import {
  MAX_PENDING_REQUESTS,
  JOINABLE_STATUSES,
  holdsSlot,
  isLapsedRequest,
  isPendingRequest,
  overlaps,
  requestExpiresAt,
  type RespondInput,
} from './requests';

/**
 * The session-request workflow: request -> (accept | reject | expire).
 *
 * Every state change is ONE Firestore transaction that re-reads the booking,
 * re-checks who may act and whether the time is still free, and writes the
 * new status together with the other side's in-app notification and the
 * scheduled work that follows from it. Either all of that commits or none of
 * it does - a mentee is never told "confirmed" by a write that rolled back.
 *
 * Emails go out AFTER the commit (afterResponse), each with a dedupe key per
 * booking and outcome. A failed send is parked in the email outbox and
 * retried with backoff (src/lib/email/send.ts), so mail problems never fail
 * or repeat a state change.
 */

export class RequestError extends Error {
  constructor(
    readonly messageKey: string,
    readonly status: number,
    readonly params?: Record<string, string | number>,
  ) {
    super(messageKey);
  }
}

const bookings = () => mentorCollections.bookings();
const expireTaskKey = (bookingId: string) => `BOOKING_REQUEST_EXPIRE:${bookingId}`;
/** A student's bookings are few; equality-only so no composite index is involved. */
const MENTEE_SCAN = 200;

async function readBooking(tx: Transaction, bookingId: string): Promise<BookingRecord | null> {
  return docToObject<BookingRecord>(await tx.get(bookings().doc(bookingId))) as BookingRecord | null;
}

async function menteeBookings(tx: Transaction, menteeId: string): Promise<BookingRecord[]> {
  const snap = await tx.get(bookings().where('menteeId', '==', menteeId).limit(MENTEE_SCAN));
  return docsToObjects<BookingRecord>(snap.docs) as BookingRecord[];
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type NewRequest = {
  mentor: { id: string; userId: string; timezone: string };
  menteeId: string;
  menteeNickname: string;
  startsAt: Date;
  endsAt: Date;
  sessionMinutes: number;
  topic: string;
  menteeNote: string | null;
  idempotencyKey: string;
};

/**
 * Creates a REQUESTED booking. A retried submit with the same idempotency key
 * returns the original (`replay: true`) instead of failing or duplicating.
 */
export async function createSessionRequest(
  input: NewRequest,
): Promise<{ booking: BookingRecord; replay: boolean }> {
  const now = new Date();
  const expiresAt = requestExpiresAt(now, input.startsAt);
  if (!expiresAt) throw new BookingError('mentors.errors.tooSoonToAnswer');

  const bookingId = bookingIdFor(input.menteeId, input.idempotencyKey);

  return adminDb().runTransaction(async (tx) => {
    // ------------------------------------------------------------- reads
    const existing = await readBooking(tx, bookingId);
    if (existing) {
      // Same key, same request: the earlier attempt succeeded. Same key,
      // different request: a client bug, never silently re-pointed.
      if (existing.mentorId === input.mentor.id && existing.startsAt.getTime() === input.startsAt.getTime()) {
        return { booking: existing, replay: true };
      }
      throw new BookingError('mentors.errors.duplicateRequest');
    }

    // The overlap check that holds under concurrency - see the header of
    // src/lib/firebase/repositories/mentors.ts.
    const clashes = await bookingsOverlapping(input.mentor.id, input.startsAt, input.endsAt, tx);
    if (clashes.length > 0) throw new BookingError('mentors.errors.slotTaken');

    const mine = (await menteeBookings(tx, input.menteeId)).filter((b) => holdsSlot(b, now));
    if (mine.some((b) => overlaps(b, input))) throw new BookingError('mentors.errors.menteeBusy');
    if (mine.filter((b) => isPendingRequest(b, now)).length >= MAX_PENDING_REQUESTS) {
      throw new BookingError('mentors.errors.tooManyPending', { max: MAX_PENDING_REQUESTS });
    }

    // ------------------------------------------------------------ writes
    const record: Omit<BookingRecord, 'id'> = {
      mentorId: input.mentor.id,
      mentorUserId: input.mentor.userId,
      menteeId: input.menteeId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.mentor.timezone,
      status: BookingStatus.REQUESTED,
      topic: input.topic,
      menteeNote: input.menteeNote,
      requestExpiresAt: expiresAt,
      respondedAt: null,
      rejectionReason: null,
      meetingProvider: null,
      meetingUrlEnc: null,
      meetingStatus: null,
      calendarEventId: null,
      idempotencyKey: input.idempotencyKey,
      confirmedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(bookings().doc(bookingId), forFirestore(record));

    // The in-app notification is what carries Accept / Decline: the panel
    // renders those buttons on BOOKING_REQUESTED rows by `bookingId`.
    enqueueNotificationTx(tx, {
      userId: input.mentor.userId,
      type: NotificationType.BOOKING_REQUESTED,
      titleKey: 'notifications.bookingRequest.title',
      bodyKey: 'notifications.bookingRequest.body',
      params: {
        bookingId,
        nickname: input.menteeNickname,
        when: input.startsAt.toISOString(),
        duration: input.sessionMinutes,
      },
      linkUrl: `/sessions/${bookingId}`,
    });

    // Makes the lapse official and tells the mentee. The slot is already
    // free at the deadline without it (isLapsedRequest), so a late run is fine.
    scheduleTx(tx, {
      kind: 'BOOKING_REQUEST_EXPIRE',
      runAt: expiresAt,
      dedupeKey: expireTaskKey(bookingId),
      payload: { bookingId },
    });

    return { booking: { id: bookingId, ...record }, replay: false };
  });
}

// ---------------------------------------------------------------------------
// Respond
// ---------------------------------------------------------------------------

export type RespondOutcome = { outcome: 'CONFIRMED' | 'REJECTED' | 'EXPIRED'; booking: BookingRecord };

/**
 * The mentor's answer.
 *
 * RBAC: only the mentor the booking was REQUESTED FROM may answer it. The
 * route has already checked the capability (mentors:console); this checks
 * ownership against the booking itself, inside the transaction. Anyone else
 * gets 404, not 403, so booking ids cannot be probed for existence.
 */
export async function respondToRequest(p: {
  bookingId: string;
  actorId: string;
  input: RespondInput;
}): Promise<RespondOutcome> {
  const actor = await findUserById(p.actorId);
  if (!actor) throw new RequestError('errors.notFound', 404);

  // A Meet room needs the mentor's calendar. Checked before anything is
  // written, so the mentor can connect it and press Accept again.
  if (p.input.action === 'accept') {
    const link = await findCalendarLink(p.actorId);
    if (link?.status !== 'ACTIVE') throw new RequestError('mentors.requests.errors.calendarRequired', 409);
  }

  const result = await adminDb().runTransaction(async (tx): Promise<RespondOutcome> => {
    const now = new Date();
    const booking = await readBooking(tx, p.bookingId);
    if (!booking) throw new RequestError('errors.notFound', 404);

    let owner = booking.mentorUserId ?? null;
    if (!owner) {
      const profile = await tx.get(mentorCollections.mentors().doc(booking.mentorId));
      owner = (profile.get('userId') as string | undefined) ?? null;
    }
    if (owner !== p.actorId) throw new RequestError('errors.notFound', 404);

    if (booking.status !== BookingStatus.REQUESTED) {
      throw new RequestError('mentors.requests.errors.alreadyAnswered', 409);
    }

    if (isLapsedRequest(booking, now)) {
      expireInTx(tx, booking, actor.nickname, now);
      return { outcome: 'EXPIRED', booking: { ...booking, status: BookingStatus.EXPIRED } };
    }

    if (p.input.action === 'reject') {
      const reason = p.input.reason;
      tx.update(
        bookings().doc(booking.id),
        forFirestore({ status: BookingStatus.REJECTED, rejectionReason: reason, respondedAt: now, updatedAt: now }),
      );
      unscheduleTx(tx, expireTaskKey(booking.id));
      enqueueNotificationTx(tx, {
        userId: booking.menteeId,
        type: NotificationType.BOOKING_REJECTED,
        titleKey: 'notifications.bookingRejected.title',
        bodyKey: 'notifications.bookingRejected.body',
        params: { nickname: actor.nickname, when: booking.startsAt.toISOString() },
        linkUrl: `/sessions/${booking.id}`,
      });
      return {
        outcome: 'REJECTED',
        booking: { ...booking, status: BookingStatus.REJECTED, rejectionReason: reason, respondedAt: now },
      };
    }

    // ---- accept: the double-booking checks, re-run under the transaction.
    const clashes = (await bookingsOverlapping(booking.mentorId, booking.startsAt, booking.endsAt, tx)).filter(
      (b) => b.id !== booking.id,
    );
    if (clashes.length > 0) throw new RequestError('mentors.errors.slotTaken', 409);

    const menteeBusy = (await menteeBookings(tx, booking.menteeId)).some(
      (b) => b.id !== booking.id && JOINABLE_STATUSES.has(b.status) && holdsSlot(b, now) && overlaps(b, booking),
    );
    if (menteeBusy) throw new RequestError('mentors.requests.errors.menteeBusy', 409);

    tx.update(
      bookings().doc(booking.id),
      forFirestore({
        status: BookingStatus.CONFIRMED,
        mentorUserId: owner,
        confirmedAt: now,
        respondedAt: now,
        meetingProvider: 'google_meet',
        meetingStatus: 'PENDING',
        updatedAt: now,
      }),
    );
    unscheduleTx(tx, expireTaskKey(booking.id));
    enqueueNotificationTx(tx, {
      userId: booking.menteeId,
      type: NotificationType.BOOKING_CONFIRMED,
      titleKey: 'notifications.bookingConfirmed.title',
      bodyKey: 'notifications.bookingConfirmed.body',
      params: { nickname: actor.nickname, when: booking.startsAt.toISOString() },
      linkUrl: `/sessions/${booking.id}`,
    });

    // Reminders are scheduled documents, so a cancellation deletes them
    // rather than a worker having to remember not to send.
    for (const [kind, offsetMs] of [
      ['BOOKING_REMINDER_24H', 24 * 3_600_000],
      ['BOOKING_REMINDER_1H', 3_600_000],
    ] as const) {
      const runAt = new Date(booking.startsAt.getTime() - offsetMs);
      if (runAt > now) {
        scheduleTx(tx, { kind, runAt, dedupeKey: `${kind}:${booking.id}`, payload: { bookingId: booking.id } });
      }
    }
    // Safety net for the Meet room: the route provisions it right after this
    // commits, and this task finishes the job if that process dies first.
    scheduleTx(tx, {
      kind: 'MEETING_PROVISION',
      runAt: new Date(now.getTime() + 2 * 60_000),
      dedupeKey: `MEETING_PROVISION:${booking.id}:0`,
      payload: { bookingId: booking.id, attempt: 1 },
    });

    return {
      outcome: 'CONFIRMED',
      booking: { ...booking, status: BookingStatus.CONFIRMED, mentorUserId: owner, confirmedAt: now, respondedAt: now },
    };
  });

  sendOutcomeEmail(result, actor.nickname);
  return result;
}

// ---------------------------------------------------------------------------
// Expire
// ---------------------------------------------------------------------------

function expireInTx(tx: Transaction, booking: BookingRecord, mentorNickname: string, now: Date): void {
  tx.update(bookings().doc(booking.id), forFirestore({ status: BookingStatus.EXPIRED, updatedAt: now }));
  unscheduleTx(tx, expireTaskKey(booking.id));
  enqueueNotificationTx(tx, {
    userId: booking.menteeId,
    type: NotificationType.BOOKING_EXPIRED,
    titleKey: 'notifications.bookingExpired.title',
    bodyKey: 'notifications.bookingExpired.body',
    params: { nickname: mentorNickname, when: booking.startsAt.toISOString() },
    linkUrl: `/mentors/${booking.mentorId}`,
  });
}

/**
 * The BOOKING_REQUEST_EXPIRE task. Does nothing unless the booking is still
 * REQUESTED and past its deadline, so a task that runs early, late or twice
 * is harmless.
 */
export async function expireRequest(bookingId: string): Promise<boolean> {
  const peek = await bookings().doc(bookingId).get();
  const mentorUserId = (peek.get('mentorUserId') as string | undefined) ?? null;
  const mentor = mentorUserId ? await findUserById(mentorUserId) : null;
  const nickname = mentor?.nickname ?? 'mentor';

  const expired = await adminDb().runTransaction(async (tx) => {
    const now = new Date();
    const booking = await readBooking(tx, bookingId);
    if (!booking || !isLapsedRequest(booking, now)) return null;
    expireInTx(tx, booking, nickname, now);
    return { ...booking, status: BookingStatus.EXPIRED };
  });
  if (expired) sendOutcomeEmail({ outcome: 'EXPIRED', booking: expired }, nickname);
  return expired !== null;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** After the commit. Never throws: delivery problems belong to the outbox. */
function sendOutcomeEmail(result: RespondOutcome, mentorNickname: string): void {
  const { booking, outcome } = result;
  afterResponse('bookings', async () => {
    const mentee = await findUserById(booking.menteeId);
    if (!mentee || mentee.deletedAt) return;
    const when = formatEmailTime(booking.startsAt, mentee.timezone);
    const dedupeKey = `booking-${outcome.toLowerCase()}:${booking.id}`;
    const base = { nickname: mentee.nickname, mentor: mentorNickname, when };

    if (outcome === 'CONFIRMED') {
      await sendEmail(
        mentee.email,
        'bookingConfirmed',
        {
          ...base,
          minutes: Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000),
          topic: booking.topic,
          path: `/sessions/${booking.id}`,
        },
        { dedupeKey },
      );
    } else if (outcome === 'REJECTED') {
      await sendEmail(
        mentee.email,
        'bookingRejected',
        { ...base, reason: booking.rejectionReason ?? '', path: `/mentors/${booking.mentorId}` },
        { dedupeKey },
      );
    } else {
      await sendEmail(mentee.email, 'bookingExpired', { ...base, path: `/mentors/${booking.mentorId}` }, { dedupeKey });
    }
  });
}

/** The mentor's "new request" email, after the request commits. */
export function sendRequestEmail(booking: BookingRecord, menteeNickname: string): void {
  afterResponse('bookings', async () => {
    if (!booking.mentorUserId) return;
    const mentor = await findUserById(booking.mentorUserId);
    if (!mentor || mentor.deletedAt) return;
    await sendEmail(
      mentor.email,
      'bookingRequested',
      {
        nickname: mentor.nickname,
        mentee: menteeNickname,
        when: formatEmailTime(booking.startsAt, mentor.timezone),
        minutes: Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000),
        topic: booking.topic,
        answerBy: formatEmailTime(booking.requestExpiresAt ?? booking.startsAt, mentor.timezone),
        path: '/notifications',
      },
      { dedupeKey: `booking-requested:${booking.id}` },
    );
  });
}
