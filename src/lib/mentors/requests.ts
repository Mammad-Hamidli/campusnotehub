import { z } from 'zod';

/**
 * Session requests: the rules, with no I/O. Client-safe (the Accept / Decline
 * control shares the reason limits) - anything needing node:crypto lives in
 * ./ids.ts.
 *
 * A booking starts life as a REQUEST the mentor answers. These are the numbers
 * and predicates every path agrees on - the request route, the respond route,
 * the slot picker, the scheduler and the join route - kept pure so the edge
 * cases are unit-tested in one place (requests.test.ts).
 *
 * ===========================================================================
 * AN UNANSWERED REQUEST EXPIRES BY ITSELF, WITHOUT A WORKER
 * ===========================================================================
 * A REQUESTED booking holds its slot, so a mentor who never answers would
 * otherwise freeze that time forever. Production has no minute-level cron
 * (Vercel runs daily jobs only and the scheduler worker is optional), so
 * expiry cannot depend on something running at the deadline. Instead every
 * reader applies isLapsedRequest(): past `requestExpiresAt` a REQUESTED
 * booking stops occupying the slot, cannot be accepted, and is no longer
 * listed as pending. The scheduled BOOKING_REQUEST_EXPIRE task only makes it
 * official (status EXPIRED) and tells the mentee - late is harmless.
 */

/** The longest a mentor has to answer. */
export const REQUEST_TTL_MS = 48 * 60 * 60_000;
/** Every request must be answered at least this long before the session starts. */
export const ANSWER_BEFORE_START_MS = 60 * 60_000;
/** A request whose answer window would be shorter than this is refused as too soon. */
export const MIN_ANSWER_WINDOW_MS = 15 * 60_000;
/** The Meet link is handed out from this long before the start... */
export const JOIN_OPENS_BEFORE_MS = 30 * 60_000;
/** ...until this long after the scheduled end, for a session that overruns. */
export const JOIN_CLOSES_AFTER_MS = 15 * 60_000;
/** Outstanding requests one mentee may have at a time, across all mentors. */
export const MAX_PENDING_REQUESTS = 5;

export const REJECTION_REASON_MIN = 10;
export const REJECTION_REASON_MAX = 500;

/** Statuses that occupy a slot (a lapsed REQUESTED one does not - see isLapsedRequest). */
export const SLOT_HOLDING_STATUSES: ReadonlySet<string> = new Set(['REQUESTED', 'CONFIRMED', 'RESCHEDULED']);
/** Statuses with a session to join. */
export const JOINABLE_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'RESCHEDULED']);

type RequestLike = { status: string; startsAt: Date; requestExpiresAt?: Date | null };

/**
 * When a request made `now` for a session at `startsAt` stops being
 * answerable: 48 hours, or one hour before the start, whichever is sooner.
 * Null when that leaves the mentor less than MIN_ANSWER_WINDOW_MS - asking
 * someone to accept a session in the next few minutes is not a real request.
 */
export function requestExpiresAt(now: Date, startsAt: Date): Date | null {
  const expires = Math.min(now.getTime() + REQUEST_TTL_MS, startsAt.getTime() - ANSWER_BEFORE_START_MS);
  return expires - now.getTime() >= MIN_ANSWER_WINDOW_MS ? new Date(expires) : null;
}

/** The answer deadline; a request written without one falls back to the start-time rule. */
export function answerDeadline(booking: RequestLike): Date {
  return booking.requestExpiresAt ?? new Date(booking.startsAt.getTime() - ANSWER_BEFORE_START_MS);
}

/** A REQUESTED booking whose answer deadline has passed. */
export function isLapsedRequest(booking: RequestLike, now: Date): boolean {
  return booking.status === 'REQUESTED' && answerDeadline(booking) <= now;
}

/** Does this booking take its time away from everyone else right now? */
export function holdsSlot(booking: RequestLike, now: Date): boolean {
  return SLOT_HOLDING_STATUSES.has(booking.status) && !isLapsedRequest(booking, now);
}

export function isPendingRequest(booking: RequestLike, now: Date): boolean {
  return booking.status === 'REQUESTED' && !isLapsedRequest(booking, now);
}

export function overlaps(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt < b.endsAt && a.endsAt > b.startsAt;
}

export type JoinState = 'early' | 'open' | 'closed';

export function joinWindow(booking: { startsAt: Date; endsAt: Date }): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: new Date(booking.startsAt.getTime() - JOIN_OPENS_BEFORE_MS),
    closesAt: new Date(booking.endsAt.getTime() + JOIN_CLOSES_AFTER_MS),
  };
}

export function joinState(booking: { startsAt: Date; endsAt: Date }, now: Date): JoinState {
  const { opensAt, closesAt } = joinWindow(booking);
  if (now < opensAt) return 'early';
  return now <= closesAt ? 'open' : 'closed';
}

/** Only a plain Google Meet room URL is ever stored or redirected to. */
export function isMeetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'meet.google.com' && /^\/[a-z0-9-]{3,64}$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** POST /api/bookings/:id/respond. A decline must say why; an accept takes nothing else. */
export const respondSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }).strict(),
  z
    .object({
      action: z.literal('reject'),
      reason: z.string().trim().min(REJECTION_REASON_MIN).max(REJECTION_REASON_MAX),
    })
    .strict(),
]);
export type RespondInput = z.infer<typeof respondSchema>;
