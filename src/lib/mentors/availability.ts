import { addMinutes } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  bookingsOverlapping,
  findMentorById,
  listAvailabilityExceptions,
  listAvailabilityRules,
} from '@/lib/firebase/repositories/mentors';

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
  const mentor = await findMentorById(params.mentorId);
  if (!mentor) throw new BookingError('errors.notFound');

  // Rules and exceptions are subcollections, so they are two reads rather than
  // an `include`. Issued concurrently: neither depends on the other.
  const [availabilityRules, availabilityExceptions] = await Promise.all([
    listAvailabilityRules(mentor.id),
    listAvailabilityExceptions(mentor.id),
  ]);

  const dayStartUtc = fromZonedTime(`${params.date}T00:00:00`, mentor.timezone);
  const localDay = toZonedTime(dayStartUtc, mentor.timezone);
  const weekday = localDay.getDay();

  // A day may carry several exceptions: a whole-day block wins; partial
  // blocks (from the mentor schedule settings) carve time out of the windows.
  const todays = availabilityExceptions.filter(
    (e) => e.date.toISOString().slice(0, 10) === params.date,
  );
  if (todays.some((e) => e.isBlocked && e.startMinute === null)) return [];
  const blocks = todays
    .filter((e) => e.isBlocked && e.startMinute !== null)
    .map((e) => ({ start: e.startMinute!, end: e.endMinute ?? 1440 }));
  const exception = todays.find((e) => !e.isBlocked && e.startMinute !== null);

  const windows = exception
    ? [{ startMinute: exception.startMinute!, endMinute: exception.endMinute ?? 1440 }]
    : availabilityRules
        .filter((r) => r.weekday === weekday)
        .filter((r) => !r.validFrom || r.validFrom <= dayStartUtc)
        .filter((r) => !r.validUntil || r.validUntil >= dayStartUtc)
        .map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute }));

  if (windows.length === 0) return [];

  const step = mentor.sessionMinutes + mentor.bufferMinutes;
  const earliest = addMinutes(new Date(), mentor.minNoticeHours * 60);

  // One query for the whole day rather than one per candidate slot.
  const dayEndUtc = addMinutes(dayStartUtc, 1440);
  const booked = await bookingsOverlapping(mentor.id, dayStartUtc, dayEndUtc);

  const slots: Slot[] = [];
  for (const w of windows) {
    for (let m = w.startMinute; m + mentor.sessionMinutes <= w.endMinute; m += step) {
      if (blocks.some((b) => m < b.end && m + mentor.sessionMinutes > b.start)) continue;
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
 * that produces a good error message; it is NOT what holds under concurrency.
 *
 * What does has changed, and the difference matters. Under Postgres it was the
 * `bookings_no_overlap` GiST exclusion constraint - a database guarantee that
 * held no matter which code path wrote the row. Firestore has no equivalent,
 * so the guarantee now lives in the booking route, which repeats this overlap
 * check INSIDE a Firestore transaction: a transactional query participates in
 * conflict detection, so two racing mentees cannot both commit.
 *
 * The practical consequence is that writing a booking document without going
 * through that transaction would silently lose the protection. See the header
 * of src/lib/firebase/repositories/mentors.ts.
 */
export async function assertSlotBookable(params: {
  mentorId: string;
  startsAt: Date;
  menteeId: string;
}) {
  const mentor = await findMentorById(params.mentorId);
  if (!mentor) throw new BookingError('errors.notFound');

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
  const clashes = await bookingsOverlapping(params.mentorId, params.startsAt, endsAt);
  if (clashes.length > 0) throw new BookingError('mentors.errors.slotTaken');

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

