import { addMinutes, startOfDay } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { db } from '@/lib/db';

export type Slot = { startsAt: Date; endsAt: Date; available: boolean };

/**
 * Computes bookable slots for one mentor on one calendar day.
 *
 * Timezone handling is the whole difficulty here and it is worth being
 * explicit, because getting it wrong produces bookings that silently drift by
 * an hour twice a year. Rules are stored as minutes-from-local-midnight in the
 * mentor's own timezone. Baku (UTC+4) has had no DST since 2016, but mentors
 * are frequently alumni working in Berlin, London or Istanbul, and the mentee
 * may be in a fourth zone. So:
 *
 *   - Availability rules  -> interpreted in the MENTOR's timezone
 *   - Slot boundaries     -> converted to absolute UTC instants for storage
 *   - Display             -> rendered in the VIEWER's timezone
 *
 * Every value that crosses a boundary is an absolute instant. Nothing that
 * touches the database is a wall-clock string.
 */
export async function getDaySlots(params: {
  mentorId: string;
  /** Calendar date as seen by the person browsing, e.g. "2026-03-14". */
  date: string;
  viewerTimezone: string;
}): Promise<Slot[]> {
  const mentor = await db.mentorProfile.findUniqueOrThrow({
    where: { id: params.mentorId },
    include: {
      availabilityRules: true,
      availabilityExceptions: true,
    },
  });

  const dayStartUtc = fromZonedTime(`${params.date}T00:00:00`, mentor.timezone);
  const localDay = toZonedTime(dayStartUtc, mentor.timezone);
  const weekday = localDay.getDay();

  const exception = mentor.availabilityExceptions.find(
    (e) => e.date.toISOString().slice(0, 10) === params.date,
  );
  if (exception?.isBlocked && exception.startMinute === null) return [];

  const windows = exception && !exception.isBlocked && exception.startMinute !== null
    ? [{ startMinute: exception.startMinute, endMinute: exception.endMinute ?? 1440 }]
    : mentor.availabilityRules
        .filter((r) => r.weekday === weekday)
        .filter((r) => !r.validFrom || r.validFrom <= dayStartUtc)
        .filter((r) => !r.validUntil || r.validUntil >= dayStartUtc)
        .map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute }));

  if (windows.length === 0) return [];

  const step = mentor.sessionMinutes + mentor.bufferMinutes;
  const earliest = addMinutes(new Date(), mentor.minNoticeHours * 60);

  // One query for the whole day rather than one per candidate slot.
  const dayEndUtc = addMinutes(dayStartUtc, 1440);
  const booked = await db.booking.findMany({
    where: {
      mentorId: mentor.id,
      status: { in: ['REQUESTED', 'CONFIRMED', 'RESCHEDULED'] },
      startsAt: { lt: dayEndUtc },
      endsAt: { gt: dayStartUtc },
    },
    select: { startsAt: true, endsAt: true },
  });

  const slots: Slot[] = [];
  for (const w of windows) {
    for (let m = w.startMinute; m + mentor.sessionMinutes <= w.endMinute; m += step) {
      const startsAt = addMinutes(dayStartUtc, m);
      const endsAt = addMinutes(startsAt, mentor.sessionMinutes);

      const overlaps = booked.some((b) => b.startsAt < endsAt && b.endsAt > startsAt);
      const tooSoon = startsAt < earliest;

      slots.push({ startsAt, endsAt, available: !overlaps && !tooSoon });
    }
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Re-validates a slot at booking time.
 *
 * The availability read and the booking write are seconds apart, and two
 * mentees looking at the same calendar will race. This check is a courtesy
 * that produces a good error message; the actual guarantee is the
 * `bookings_no_overlap` GiST exclusion constraint in the database, which is
 * the only thing that holds under concurrency.
 */
export async function assertSlotBookable(params: {
  mentorId: string;
  startsAt: Date;
  menteeId: string;
}) {
  const mentor = await db.mentorProfile.findUniqueOrThrow({
    where: { id: params.mentorId },
    select: {
      userId: true,
      sessionMinutes: true,
      minNoticeHours: true,
      timezone: true,
      isApproved: true,
      isAcceptingBookings: true,
    },
  });

  if (params.menteeId === mentor.userId) {
    throw new BookingError('mentors.errors.selfBooking');
  }
  if (!mentor.isApproved || !mentor.isAcceptingBookings) {
    throw new BookingError('mentors.profile.notAccepting');
  }

  const minStart = addMinutes(new Date(), mentor.minNoticeHours * 60);
  if (params.startsAt < minStart) {
    throw new BookingError('mentors.errors.tooSoon', { hours: mentor.minNoticeHours });
  }

  const endsAt = addMinutes(params.startsAt, mentor.sessionMinutes);
  const clash = await db.booking.findFirst({
    where: {
      mentorId: params.mentorId,
      status: { in: ['REQUESTED', 'CONFIRMED', 'RESCHEDULED'] },
      startsAt: { lt: endsAt },
      endsAt: { gt: params.startsAt },
    },
    select: { id: true },
  });
  if (clash) throw new BookingError('mentors.errors.slotTaken');

  const dayKey = toZonedTime(params.startsAt, mentor.timezone).toISOString().slice(0, 10);
  const offered = await getDaySlots({
    mentorId: params.mentorId,
    date: dayKey,
    viewerTimezone: mentor.timezone,
  });
  const match = offered.find(
    (s) => s.startsAt.getTime() === params.startsAt.getTime() && s.available,
  );
  if (!match) throw new BookingError('mentors.errors.slotTaken');

  return { endsAt, sessionMinutes: mentor.sessionMinutes };
}

export class BookingError extends Error {
  constructor(
    public readonly messageKey: string,
    public readonly params?: Record<string, string | number>,
  ) {
    super(messageKey);
  }
}

/** Groups slots into morning/afternoon/evening for the picker UI. */
export function groupSlots(slots: Slot[], timezone: string) {
  const bucket = (d: Date) => {
    const h = toZonedTime(d, timezone).getHours();
    if (h < 12) return 'morning' as const;
    if (h < 17) return 'afternoon' as const;
    return 'evening' as const;
  };
  return slots.reduce<Record<'morning' | 'afternoon' | 'evening', Slot[]>>(
    (acc, s) => {
      acc[bucket(s.startsAt)].push(s);
      return acc;
    },
    { morning: [], afternoon: [], evening: [] },
  );
}

export const dayBoundary = (date: string, tz: string) =>
  startOfDay(toZonedTime(fromZonedTime(`${date}T00:00:00`, tz), tz));
