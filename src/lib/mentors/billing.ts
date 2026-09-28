/**
 * The mentor's monthly fee reminder - dates only.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO "PAID" OR "OVERDUE"
 * ---------------------------------------------------------------------------
 * The fee is paid directly to CampusNoteHub, outside the product. The platform
 * takes no payment and records none, so this computes WHEN a payment falls
 * due, never WHETHER one was made. An "overdue" badge would be a guess
 * presented as a fact, and it would be wrong for every mentor who paid.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEDULE
 * ---------------------------------------------------------------------------
 * The anchor is the mentor's join date (`mentorSince` on the user document).
 * The first payment falls exactly one calendar month after joining, then
 * monthly on the same day. A day the month does not have clamps to its last
 * day WITHOUT drifting: joined 31 January -> 28/29 February -> 31 March.
 *
 * Dates are CALENDAR dates in the mentor's time zone, not instants. Someone
 * who joined at 01:30 in Baku joined on that Baku date, even though it was
 * still the previous day in UTC; comparing instants would show them a due
 * date one day early for half the day.
 *
 * Pure and server-only in practice: it is rendered by a Server Component, so
 * the Intl call below never runs in a browser (see the az hydration note in
 * PaymentReminderCard).
 */

const DAY_MS = 86_400_000;

/** From this many days before the due date, the reminder is emphasised. */
export const REMINDER_WINDOW_DAYS = 7;

export type BillingUrgency = 'today' | 'soon' | 'upcoming';

export type BillingSnapshot = {
  /** YYYY-MM-DD in the given time zone. */
  joinedOn: string;
  /** YYYY-MM-DD in the given time zone. */
  nextDueOn: string;
  /** Whole days from today to nextDueOn; 0 on the due date itself. */
  daysLeft: number;
  /** 1 for the first payment, 2 for the second, and so on. */
  cycle: number;
  urgency: BillingUrgency;
};

/** A calendar date with a 0-based month, as Date.UTC takes it. */
type CalendarDate = { y: number; m: number; d: number };

function calendarDateIn(instant: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { y: part('year'), m: part('month') - 1, d: part('day') };
}

/** A calendar date as whole days since 1970-01-01. Date.UTC normalises month overflow. */
const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m, d) / DAY_MS;

const isoDate = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The anchor's day of the month, `offset` months later, clamped to that month's length. */
function dueDayAfter(anchor: CalendarDate, offset: number): number {
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(anchor.y, anchor.m + offset + 1, 0)).getUTCDate();
  return dayNumber(anchor.y, anchor.m + offset, Math.min(anchor.d, lastDay));
}

export function billingSnapshot(since: Date, now: Date, timeZone = 'Asia/Baku'): BillingSnapshot {
  const joined = calendarDateIn(since, timeZone);
  const current = calendarDateIn(now, timeZone);
  const today = dayNumber(current.y, current.m, current.d);

  /**
   * The due date in the current calendar month is either still ahead (that is
   * the answer) or already behind (then the next month's is). Never earlier
   * than one month after joining, which also covers a join date that reads as
   * "in the future" through clock skew.
   */
  let cycle = Math.max(1, (current.y - joined.y) * 12 + (current.m - joined.m));
  if (dueDayAfter(joined, cycle) < today) cycle += 1;

  const due = dueDayAfter(joined, cycle);
  const daysLeft = due - today;

  return {
    joinedOn: isoDate(dayNumber(joined.y, joined.m, joined.d)),
    nextDueOn: isoDate(due),
    daysLeft,
    cycle,
    urgency: daysLeft === 0 ? 'today' : daysLeft <= REMINDER_WINDOW_DAYS ? 'soon' : 'upcoming',
  };
}
