import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminDb } from '@/lib/firebase/admin';
import { forFirestore } from '@/lib/firebase/convert';
import {
  ACTIVE_BOOKING_STATUSES,
  bookingIdFor,
  mentorCollections,
} from '@/lib/firebase/repositories/mentors';
import { scheduleTx } from '@/lib/firebase/repositories/scheduledTasks';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { assertSlotBookable, BookingError, getDaySlots } from '@/lib/mentors/availability';
import { sealJson } from '@/lib/crypto/vault';
import { enqueueNotificationTx } from '@/lib/notifications/dispatch';
import { createMeetingRoom } from '@/lib/mentors/meeting';

export const runtime = 'nodejs';

const listSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().max(64).default('Asia/Baku'),
});

/** GET /api/mentors/:id/bookings?date=YYYY-MM-DD - the slot picker's data source. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mentorId: string }> },
) {
  const { mentorId } = await params;
  const query = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });

  const slots = await getDaySlots({
    mentorId,
    date: query.data.date,
    viewerTimezone: query.data.tz,
  });

  return NextResponse.json({
    date: query.data.date,
    timezone: query.data.tz,
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      available: s.available,
    })),
  });
}

const createSchema = z.object({
  startsAt: z.string().datetime(),
  topic: z.string().trim().min(5).max(300),
  menteeNote: z.string().trim().max(2000).optional(),
  idempotencyKey: z.string().uuid(),
});

/**
 * POST /api/mentors/:id/bookings
 *
 * Books a slot in a single transaction: the overlap check, the booking, the
 * mentor's notification and the reminders commit together or not at all.
 * Bookings are free - the platform holds no money.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ mentorId: string }> },
) {
  const { mentorId } = await params;

  /**
   * `can`, not `assertCan`.
   *
   * assertCan THROWS a ForbiddenError and nothing here caught it, so an
   * UNVERIFIED student pressing Book - the single most likely refusal on this
   * endpoint, since booking is exactly what verification gates - got a 500
   * with a stack trace instead of a message telling them to verify. Same
   * defect and same fix as POST /api/feed.
   */
  let userId: string;
  let viewer;
  try {
    ({ userId, viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  if (!can(viewer, 'mentors:book')) {
    return NextResponse.json({ error: 'verification.restricted.title' }, { status: 403 });
  }

  const rate = await rateLimit('bookings:create', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });

  const startsAt = new Date(parsed.data.startsAt);

  try {
    const { endsAt, sessionMinutes } = await assertSlotBookable({ mentorId, startsAt, menteeId: userId });

    /**
     * The booking id and the meeting room are both
     * DERIVED, and all computed before the transaction opens.
     *
     * That is not a micro-optimisation, it is what makes the transaction
     * possible at all. The old code created the booking row to learn its id,
     * then called createMeetingRoom() and sealJson() with it, then updated the
     * row - three writes interleaved with an async encryption call. A Firestore
     * transaction may not interleave unrelated async work between its reads and
     * its writes, and it re-runs its body on contention, so sealing inside it
     * would redo the crypto on every retry.
     *
     * Because bookingIdFor() is a pure function of (mentor, slot), all of it
     * can happen up front and the transaction becomes reads-then-writes with
     * nothing in between.
     */
    const bookingId = bookingIdFor(mentorId, startsAt);
    const meeting = await createMeetingRoom({ bookingId, startsAt, endsAt });
    // Encrypted at rest and only handed out inside a 30-minute window around
    // the session - a link that leaks days early is a link strangers can join.
    const meetingUrlEnc = await sealJson({ url: meeting.url }, { bookingId });

    const bookingRef = mentorCollections.bookings().doc(bookingId);

    const booking = await adminDb().runTransaction(async (tx) => {
      // ------------------------------------------------------------- reads
      const mentorSnap = await tx.get(mentorCollections.mentors().doc(mentorId));
      if (!mentorSnap.exists) throw new BookingError('errors.notFound');
      const mentor = mentorSnap.data() as {
        userId: string;
        sessionMinutes: number;
        timezone: string;
      };

      /**
       * The overlap check, re-run INSIDE the transaction.
       *
       * assertSlotBookable() already checked this, but that check is a
       * courtesy that produces a good error message - it cannot hold under
       * concurrency. This one can: a transactional query participates in
       * Firestore conflict detection, so if a competing booking lands between
       * this read and the commit, the transaction aborts and re-runs.
       *
       * It is the replacement for the `bookings_no_overlap` GiST exclusion
       * constraint, which has no Firestore equivalent. The derived document id
       * covers the exact-same-instant case; this covers genuine overlap.
       */
      const clashSnap = await tx.get(
        mentorCollections
          .bookings()
          .where('mentorId', '==', mentorId)
          .where('status', 'in', ACTIVE_BOOKING_STATUSES as unknown as string[])
          .where('startsAt', '>=', new Date(startsAt.getTime() - 6 * 60 * 60_000))
          .where('startsAt', '<', endsAt),
      );
      const clash = clashSnap.docs.some((doc) => {
        const data = doc.data();
        const otherEnds: Date = data.endsAt?.toDate?.() ?? data.endsAt;
        return doc.id !== bookingId && otherEnds > startsAt;
      });
      if (clash) throw new BookingError('mentors.errors.slotTaken');

      // ------------------------------------------------------------ writes
      // Bookings are free: the platform no longer holds money, so there is no
      // wallet debit or escrow leg - the booking document is the whole record.
      const now = new Date();
      const record = {
        mentorId,
        menteeId: userId,
        startsAt,
        endsAt,
        timezone: mentor.timezone,
        status: 'CONFIRMED',
        topic: parsed.data.topic,
        menteeNote: parsed.data.menteeNote ?? null,
        meetingProvider: meeting.provider,
        meetingUrlEnc,
        idempotencyKey: parsed.data.idempotencyKey,
        confirmedAt: now,
        completedAt: null,
        cancelledAt: null,
        cancelReason: null,
        createdAt: now,
        updatedAt: now,
      };
      // `create`, not `set`: a resubmitted form must collide on the derived id
      // rather than overwrite someone else's booking.
      tx.create(bookingRef, forFirestore(record));

      enqueueNotificationTx(tx, {
        userId: mentor.userId,
        type: 'BOOKING_REQUESTED',
        titleKey: 'notifications.types.BOOKING_REQUESTED',
        bodyKey: 'mentors.booking.summary',
        params: { date: startsAt.toISOString(), duration: sessionMinutes },
        linkUrl: '/bookings',
      });

      // Reminders are scheduled documents, so a cancellation deletes them
      // rather than a worker having to remember not to send.
      for (const [kind, offsetMs] of [
        ['BOOKING_REMINDER_24H', 24 * 3_600_000],
        ['BOOKING_REMINDER_1H', 3_600_000],
      ] as const) {
        const runAt = new Date(startsAt.getTime() - offsetMs);
        if (runAt > new Date()) {
          scheduleTx(tx, {
            kind,
            runAt,
            dedupeKey: `${kind}:${bookingId}`,
            payload: { bookingId },
          });
        }
      }

      return { id: bookingId, ...record };
    });

    return NextResponse.json(
      {
        booking: {
          id: booking.id,
          startsAt: booking.startsAt.toISOString(),
          endsAt: booking.endsAt.toISOString(),
          status: booking.status,
        },
        messageKey: 'mentors.booking.confirmed.body',
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof BookingError) {
      return NextResponse.json({ error: error.messageKey, params: error.params }, { status: 409 });
    }
    /**
     * ALREADY_EXISTS on the derived booking id: someone else won the race for
     * this exact slot. The successor to the GiST exclusion constraint firing,
     * and the same answer - the slot is taken.
     */
    if ((error as { code?: number }).code === 6) {
      return NextResponse.json({ error: 'mentors.errors.slotTaken' }, { status: 409 });
    }
    throw error;
  }
}
