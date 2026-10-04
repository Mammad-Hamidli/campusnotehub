import { createHash } from 'node:crypto';

/**
 * The booking id: a hash of the mentee and the form's idempotency key.
 *
 * It used to be derived from (mentor, slot), which made the slot itself the
 * uniqueness key. That stops working once a mentor can DECLINE: the declined
 * booking would occupy the slot's id forever, and the next person to request
 * that time would collide with it. Slot exclusivity is held by the
 * transactional overlap query instead (see the request route), and this id
 * makes a retried submit - a double-tap, a lost response - land on the same
 * document and come back as a replay rather than a second request.
 */
export function bookingIdFor(menteeId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`booking:${menteeId}:${idempotencyKey}`).digest('hex').slice(0, 32);
}

/**
 * The Google Calendar event id for a booking. Deterministic, so a retried
 * insert collides (409) instead of creating a second event with a second Meet
 * room. Google allows base32hex (a-v, 0-9), 5-1024 chars; hex is a subset.
 */
export function meetEventIdFor(bookingId: string): string {
  return 'ch' + createHash('sha256').update(`meet-event:${bookingId}`).digest('hex').slice(0, 40);
}
