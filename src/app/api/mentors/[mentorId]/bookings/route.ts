import { NextResponse, type NextRequest } from 'next/server';
import { LedgerTxnKind } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth/session';
import { assertCan } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { assertSlotBookable, BookingError, getDaySlots } from '@/lib/mentors/availability';
import { getAccount, post as postLedger, splitPrice } from '@/lib/wallet/ledger';
import { sealJson } from '@/lib/crypto/vault';
import { enqueueNotification } from '@/lib/notifications/dispatch';
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
 * Books a slot and moves money into escrow in a single transaction. The
 * mentor is not paid on booking - funds sit in PLATFORM_ESCROW and are
 * released when the session is marked complete, so a no-show is refundable
 * without clawing back an already-withdrawn balance.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ mentorId: string }> },
) {
  const { mentorId } = await params;
  const { userId, viewer } = await requireSession(request);
  assertCan(viewer, 'mentors:book');

  const rate = await rateLimit('bookings:create', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });

  const startsAt = new Date(parsed.data.startsAt);

  try {
    const { endsAt, sessionMinutes } = await assertSlotBookable({ mentorId, startsAt, menteeId: userId });

    const booking = await db.$transaction(async (tx) => {
      const mentor = await tx.mentorProfile.findUniqueOrThrow({
        where: { id: mentorId },
        select: { id: true, userId: true, hourlyRateMinor: true, sessionMinutes: true, timezone: true },
      });

      const priceMinor = Math.round((mentor.hourlyRateMinor * sessionMinutes) / 60);
      const { platformFeeMinor } = splitPrice(priceMinor);

      const [wallet] = await tx.$queryRaw<{ id: string; availableMinor: number }[]>`
        SELECT id, "availableMinor" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
      `;
      if (!wallet || wallet.availableMinor < priceMinor) {
        throw new BookingError('notes.errors.insufficientFunds');
      }

      const created = await tx.booking.create({
        data: {
          mentorId: mentor.id,
          menteeId: userId,
          startsAt,
          endsAt,
          timezone: mentor.timezone,
          topic: parsed.data.topic,
          menteeNote: parsed.data.menteeNote,
          priceMinor,
          platformFeeMinor,
          idempotencyKey: parsed.data.idempotencyKey,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      });

      // The meeting URL is created now but encrypted at rest and only handed
      // out inside a 30-minute window around the session - a link that leaks
      // days early is a link strangers can join.
      const meeting = await createMeetingRoom({ bookingId: created.id, startsAt, endsAt });
      await tx.booking.update({
        where: { id: created.id },
        data: {
          meetingProvider: meeting.provider,
          meetingUrlEnc: await sealJson({ url: meeting.url }, { bookingId: created.id }),
        },
      });

      const menteeAvailable = await getAccount(tx, wallet.id, 'USER_AVAILABLE');
      const escrow = await getAccount(tx, null, 'PLATFORM_ESCROW');
      const txn = await postLedger(tx, {
        kind: LedgerTxnKind.BOOKING_ESCROW_HOLD,
        referenceKey: `booking:${created.id}`,
        description: `Escrow hold for booking ${created.id}`,
        legs: [
          { accountId: menteeAvailable.id, amountMinor: -priceMinor },
          { accountId: escrow.id, amountMinor: priceMinor },
        ],
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { availableMinor: { decrement: priceMinor }, version: { increment: 1 } },
      });
      await tx.booking.update({ where: { id: created.id }, data: { escrowTxnId: txn.id } });

      await enqueueNotification(tx, {
        userId: mentor.userId,
        type: 'BOOKING_REQUESTED',
        titleKey: 'notifications.types.BOOKING_REQUESTED',
        bodyKey: 'mentors.booking.summary',
        params: { date: startsAt.toISOString(), duration: sessionMinutes },
        linkUrl: `/mentors/sessions/${created.id}`,
      });

      // Reminders are scheduled rows, so a cancellation deletes them rather
      // than a worker having to remember not to send.
      for (const [kind, offsetMs] of [
        ['BOOKING_REMINDER_24H', 24 * 3_600_000],
        ['BOOKING_REMINDER_1H', 3_600_000],
      ] as const) {
        const runAt = new Date(startsAt.getTime() - offsetMs);
        if (runAt > new Date()) {
          await tx.scheduledTask.create({
            data: {
              kind,
              runAt,
              dedupeKey: `${kind}:${created.id}`,
              payload: { bookingId: created.id },
            },
          });
        }
      }

      return created;
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
    // The GiST exclusion constraint fired: someone else won the race.
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2010') {
      return NextResponse.json({ error: 'mentors.errors.slotTaken' }, { status: 409 });
    }
    throw error;
  }
}
