import type { Transaction } from 'firebase-admin/firestore';
import { adminDb } from '../admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore, sortBy } from '../convert';
import { holdsSlot, isPendingRequest } from '@/lib/mentors/requests';

/**
 * PocketMentor: profiles, availability, bookings and reviews.
 *
 * ===========================================================================
 * WHAT KEEPS TWO BOOKINGS OUT OF THE SAME TIME
 * ===========================================================================
 * Postgres had a GiST exclusion constraint (`bookings_no_overlap`). Firestore
 * has no equivalent - no index type can express "these ranges must not
 * intersect".
 *
 * What holds instead: the request route runs the overlap check INSIDE a
 * Firestore transaction. A transactional query participates in conflict
 * detection - if any document matching it is written before the commit, the
 * transaction aborts and re-runs - so two mentees racing for overlapping slots
 * cannot both succeed. Accepting a request re-runs the same check. This is a
 * real guarantee rather than a check-then-act, but it lives in code rather
 * than in the database, so it must not be bypassed by writing a booking
 * document directly.
 *
 * The booking id is NOT the slot any more (see bookingIdFor in
 * src/lib/mentors/requests.ts): once a mentor can decline, a slot-derived id
 * would stay occupied by the declined request forever.
 *
 * ===========================================================================
 * AVAILABILITY IS A SUBCOLLECTION
 * ===========================================================================
 * Rules and exceptions belong to exactly one mentor and are always read with
 * them. They are not arrays on the profile because a mentor with a dense
 * calendar accumulates exceptions indefinitely, and an unbounded array is how
 * a document walks into the 1 MiB limit.
 */

export type MentorProfileRecord = {
  id: string;
  userId: string;
  industry: string;
  specialties: string[];
  headline: string;
  about: string;
  company: string | null;
  jobTitle: string | null;
  yearsExperience: number;
  linkedinUrl: string | null;
  languages: string[];
  hourlyRateMinor: number;
  sessionMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  timezone: string;
  isApproved: boolean;
  approvedAt: Date | null;
  isAcceptingBookings: boolean;
  ratingAvg: number;
  ratingCount: number;
  sessionsCompleted: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AvailabilityRuleRecord = {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  validFrom: Date | null;
  validUntil: Date | null;
};

export type AvailabilityExceptionRecord = {
  id: string;
  date: Date;
  isBlocked: boolean;
  startMinute: number | null;
  endMinute: number | null;
};

export type MeetingStatus = 'PENDING' | 'READY' | 'NEEDS_CALENDAR' | 'FAILED';

export type BookingRecord = {
  id: string;
  mentorId: string;
  /** The mentor's USER id, copied at request time: the ownership check for answering. */
  mentorUserId?: string | null;
  menteeId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status: string;
  topic: string;
  menteeNote: string | null;
  /** REQUESTED only: after this the request no longer holds the slot. */
  requestExpiresAt?: Date | null;
  respondedAt?: Date | null;
  /** The mentor's reason, required to decline. Shown to the mentee. */
  rejectionReason?: string | null;
  /** Sealed (vault, AAD = bookingId); only the join route opens it. */
  meetingUrlEnc: string | null;
  meetingProvider: string | null;
  meetingStatus?: MeetingStatus | null;
  meetingError?: string | null;
  calendarEventId?: string | null;
  idempotencyKey: string;
  confirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MentorReviewRecord = {
  id: string;
  mentorId: string;
  /** The most recent finished session that made the review possible. */
  bookingId: string;
  menteeId: string;
  rating: number;
  body: string | null;
  createdAt: Date;
  updatedAt?: Date;
};

/** Statuses that occupy a slot. A cancelled booking frees the time. */
export const ACTIVE_BOOKING_STATUSES = ['REQUESTED', 'CONFIRMED', 'RESCHEDULED'] as const;

const mentors = () => adminDb().collection(COLLECTIONS.mentorProfiles);
const bookings = () => adminDb().collection(COLLECTIONS.bookings);
const reviews = () => adminDb().collection(COLLECTIONS.mentorReviews);
const rules = (mentorId: string) => adminDb().collection(SUBCOLLECTIONS.availability(mentorId));
const exceptions = (mentorId: string) =>
  adminDb().collection(SUBCOLLECTIONS.availabilityExceptions(mentorId));

export async function findMentorById(id: string): Promise<MentorProfileRecord | null> {
  return docToObject<MentorProfileRecord>(
    await mentors().doc(id).get(),
  ) as MentorProfileRecord | null;
}

/**
 * Profiles by id in one batched read, for lists that name several (the feed
 * ad). Missing ids are simply absent from the map. Callers bound the list.
 */
export async function findMentorsByIds(ids: string[]): Promise<Map<string, MentorProfileRecord>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, MentorProfileRecord>();
  if (unique.length === 0) return out;

  const snaps = await adminDb().getAll(...unique.map((id) => mentors().doc(id)));
  for (const snap of snaps) {
    const row = docToObject<MentorProfileRecord>(snap);
    if (row) out.set(row.id, row as MentorProfileRecord);
  }
  return out;
}

export async function findMentorByUserId(userId: string): Promise<MentorProfileRecord | null> {
  const snap = await mentors().where('userId', '==', userId).limit(1).get();
  return (docsToObjects<MentorProfileRecord>(snap.docs)[0] as MentorProfileRecord) ?? null;
}

export type MentorListFilter = {
  industry?: string;
  q?: string;
  minYears?: number;
  maxPriceMinor?: number;
  acceptingOnly?: boolean;
};

/**
 * The directory.
 *
 * `isApproved == true` is applied in the QUERY and is not a filter the caller
 * can turn off. A mentor profile is a claim about someone's employer,
 * seniority and expertise, made to students who will then sit in a one-to-one
 * call with them - so an unreviewed profile must never be discoverable, and
 * that has to be structural rather than a parameter.
 *
 * The free-text search matches five fields at once, which is a Postgres `OR`
 * with `ILIKE` and has no Firestore equivalent. As in listUsers(), the
 * indexable equality filter narrows the read and the text match runs over what
 * comes back, under a ceiling. A real directory outgrowing this wants a search
 * index, not a larger scan.
 */
const DIRECTORY_SCAN_CEILING = 1000;

export async function listMentors(
  filter: MentorListFilter,
  sort: 'rating' | 'sessions' | 'recent' | 'price',
  cursor: number,
  limit: number,
): Promise<{ mentors: MentorProfileRecord[]; total: number }> {
  let query: FirebaseFirestore.Query = mentors().where('isApproved', '==', true);
  if (filter.industry) query = query.where('industry', '==', filter.industry);

  const snap = await query.limit(DIRECTORY_SCAN_CEILING).get();
  let rows = docsToObjects<MentorProfileRecord>(snap.docs) as MentorProfileRecord[];

  if (filter.q) {
    const needle = filter.q.toLowerCase();
    rows = rows.filter(
      (m) =>
        m.headline?.toLowerCase().includes(needle) ||
        m.about?.toLowerCase().includes(needle) ||
        m.company?.toLowerCase().includes(needle) ||
        m.jobTitle?.toLowerCase().includes(needle) ||
        // Whole-tag match, as the Postgres array containment did.
        (m.specialties ?? []).some((s) => s.toLowerCase() === needle),
    );
  }

  // Applied in memory, like the text search: a combination of range filters
  // on different fields cannot be one Firestore query.
  if (filter.minYears !== undefined) {
    const minYears = filter.minYears;
    rows = rows.filter((m) => (m.yearsExperience ?? 0) >= minYears);
  }
  if (filter.maxPriceMinor !== undefined) {
    const maxPrice = filter.maxPriceMinor;
    rows = rows.filter((m) => (m.hourlyRateMinor ?? 0) <= maxPrice);
  }
  if (filter.acceptingOnly) rows = rows.filter((m) => m.isAcceptingBookings);

  rows.sort((a, b) => {
    if (sort === 'sessions') {
      return (b.sessionsCompleted ?? 0) - (a.sessionsCompleted ?? 0) || a.id.localeCompare(b.id);
    }
    if (sort === 'recent') {
      return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) || a.id.localeCompare(b.id);
    }
    if (sort === 'price') {
      return (a.hourlyRateMinor ?? 0) - (b.hourlyRateMinor ?? 0) || a.id.localeCompare(b.id);
    }
    // Rating, then volume: a lone 5.0 review should not outrank a mentor with
    // fifty sessions at 4.8.
    return (
      Number(b.ratingAvg ?? 0) - Number(a.ratingAvg ?? 0) ||
      (b.ratingCount ?? 0) - (a.ratingCount ?? 0) ||
      a.id.localeCompare(b.id)
    );
  });

  return { mentors: rows.slice(cursor, cursor + limit + 1), total: rows.length };
}

export async function listAvailabilityRules(mentorId: string): Promise<AvailabilityRuleRecord[]> {
  const snap = await rules(mentorId).get();
  return sortBy(docsToObjects<AvailabilityRuleRecord>(snap.docs) as AvailabilityRuleRecord[], 'weekday');
}

export async function listAvailabilityExceptions(
  mentorId: string,
): Promise<AvailabilityExceptionRecord[]> {
  const snap = await exceptions(mentorId).get();
  return docsToObjects<AvailabilityExceptionRecord>(snap.docs) as AvailabilityExceptionRecord[];
}

/**
 * Queues "replace all weekly rules" onto a batch. Existing rule ids must be
 * read by the caller first (a batch cannot read), so approval and settings
 * share this without either owning the read.
 */
export function replaceRulesInBatch(
  batch: FirebaseFirestore.WriteBatch,
  mentorId: string,
  existingIds: string[],
  next: { weekday: number; startMinute: number; endMinute: number }[],
): void {
  for (const id of existingIds) batch.delete(rules(mentorId).doc(id));
  for (const r of next) {
    batch.set(rules(mentorId).doc(), { ...r, validFrom: null, validUntil: null });
  }
}

/**
 * Settings save: weekly rules, blocked dates and booking knobs, atomically.
 * Past exceptions are pruned on every save so the subcollection stays bounded.
 */
export async function saveMentorSchedule(
  mentorId: string,
  input: {
    rules: { weekday: number; startMinute: number; endMinute: number }[];
    blocked: { date: string; startMinute: number | null; endMinute: number | null }[];
    profile: Record<string, unknown>;
  },
): Promise<void> {
  const [ruleSnap, exceptionSnap] = await Promise.all([rules(mentorId).get(), exceptions(mentorId).get()]);
  const batch = adminDb().batch();

  replaceRulesInBatch(batch, mentorId, ruleSnap.docs.map((d) => d.id), input.rules);
  for (const doc of exceptionSnap.docs) batch.delete(doc.ref);
  for (const b of input.blocked) {
    batch.set(exceptions(mentorId).doc(), {
      // UTC midnight: getDaySlots matches on toISOString().slice(0, 10).
      date: new Date(`${b.date}T00:00:00Z`),
      isBlocked: true,
      startMinute: b.startMinute,
      endMinute: b.endMinute,
    });
  }
  batch.update(mentors().doc(mentorId), forFirestore({ ...input.profile, updatedAt: new Date() }));
  await batch.commit();
}

export async function findBookingById(id: string): Promise<BookingRecord | null> {
  return docToObject<BookingRecord>(await bookings().doc(id).get()) as BookingRecord | null;
}

/**
 * Bookings that could occupy any part of a window.
 *
 * Firestore permits a range filter on ONE field per query, so `startsAt < end
 * AND endsAt > start` - a range on two fields, which is what an overlap test
 * needs - is not expressible. The query therefore ranges on `startsAt` alone
 * and the `endsAt` half of the test is applied to the result.
 *
 * That is exact rather than approximate, because the lower bound is real: a
 * session has a bounded length, so nothing starting before `windowStart` minus
 * the longest plausible session can still be running inside the window.
 */
const MAX_SESSION_MS = 6 * 60 * 60_000;

export async function bookingsOverlapping(
  mentorId: string,
  windowStart: Date,
  windowEnd: Date,
  tx?: Transaction,
): Promise<BookingRecord[]> {
  const query = bookings()
    .where('mentorId', '==', mentorId)
    .where('status', 'in', ACTIVE_BOOKING_STATUSES as unknown as string[])
    .where('startsAt', '>=', new Date(windowStart.getTime() - MAX_SESSION_MS))
    .where('startsAt', '<', windowEnd);

  const snap = tx ? await tx.get(query) : await query.get();
  // A lapsed request is still REQUESTED in storage but no longer holds its slot.
  const now = new Date();
  return (docsToObjects<BookingRecord>(snap.docs) as BookingRecord[]).filter(
    (b) => b.endsAt > windowStart && holdsSlot(b, now),
  );
}

/**
 * Every session of the mentor's that has not ended, soonest first - the
 * mentor panel counts them and lists the first few.
 *
 * Equality on mentorId ONLY, then filtered and ordered in memory. Adding a
 * range or order on startsAt would need the composite index that
 * firestore.indexes.json declares but nothing guarantees is deployed, and a
 * missing index is a FAILED_PRECONDITION that would take the whole panel
 * down. `scan` bounds the read; one mentor's bookings stay far below it.
 */
export async function listUpcomingMentorBookings(
  mentorId: string,
  now: Date,
  scan = 500,
): Promise<BookingRecord[]> {
  const snap = await bookings().where('mentorId', '==', mentorId).limit(scan).get();
  return (docsToObjects<BookingRecord>(snap.docs) as BookingRecord[])
    .filter((b) => holdsSlot(b, now) && b.endsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Requests waiting for this mentor's answer, oldest deadline first. Same query shape as above. */
export async function listPendingRequests(mentorId: string, now: Date): Promise<BookingRecord[]> {
  const snap = await bookings().where('mentorId', '==', mentorId).where('status', '==', 'REQUESTED').limit(200).get();
  return (docsToObjects<BookingRecord>(snap.docs) as BookingRecord[])
    .filter((b) => isPendingRequest(b, now))
    .sort((a, b) => (a.requestExpiresAt?.getTime() ?? 0) - (b.requestExpiresAt?.getTime() ?? 0));
}

/**
 * Who may answer a booking and host its call. Bookings written before
 * `mentorUserId` existed fall back to the profile, which is the same fact.
 */
export async function mentorUserIdOf(booking: Pick<BookingRecord, 'mentorId' | 'mentorUserId'>): Promise<string | null> {
  if (booking.mentorUserId) return booking.mentorUserId;
  return (await findMentorById(booking.mentorId))?.userId ?? null;
}

// ---------------------------------------------------------------- reviews
//
// The same mechanics as note reviews (upsertNoteReview in notes.ts), with a
// finished session standing in for the PAID order:
//
//   eligibility - the mentee has a booking with this mentor that was confirmed
//                 and whose end time has passed. Re-read INSIDE the review
//                 transaction, never inferred from the client.
//   identity    - review id = mentorId__menteeId, so one mentee is one
//                 reviewer (ratingCount counts unique reviewers) and re-rating
//                 replaces rather than adds.
//   aggregates  - ratingSum / ratingCount / ratingAvg on the mentor profile,
//                 updated in the same transaction as the review.

/**
 * Booking statuses that mean the session was ON. Nothing moves a booking to
 * COMPLETED today, so a CONFIRMED (or RESCHEDULED) booking whose end time has
 * passed is what "the session happened" means; COMPLETED is included so the
 * rule keeps working once something does set it.
 */
const REVIEWABLE_BOOKING_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'RESCHEDULED', 'COMPLETED']);

export class MentorReviewError extends Error {
  constructor(readonly messageKey: string, readonly status: number) {
    super(messageKey);
  }
}

export function mentorReviewIdFor(mentorId: string, menteeId: string): string {
  return `${mentorId}__${menteeId}`;
}

/** Equality on two fields only: served by single-field indexes, no composite needed. */
function bookingsBetween(mentorId: string, menteeId: string) {
  return bookings().where('mentorId', '==', mentorId).where('menteeId', '==', menteeId).limit(100);
}

/** The latest finished session between the two, or null. */
function latestFinished(docs: FirebaseFirestore.QueryDocumentSnapshot[], now: Date): string | null {
  let best: { id: string; endsAt: number } | null = null;
  for (const doc of docs) {
    const data = doc.data();
    const endsAt = (data.endsAt as FirebaseFirestore.Timestamp | undefined)?.toMillis?.() ?? 0;
    if (!REVIEWABLE_BOOKING_STATUSES.has(String(data.status)) || endsAt > now.getTime()) continue;
    if (!best || endsAt > best.endsAt) best = { id: doc.id, endsAt };
  }
  return best?.id ?? null;
}

/**
 * What the viewer may do in the review box on a mentor's page: whether they
 * have had a session (so may review), and their existing review to pre-fill.
 */
export async function findViewerMentorReview(
  mentorId: string,
  menteeId: string,
): Promise<{ eligible: boolean; rating: number | null; body: string | null }> {
  const [sessions, review] = await Promise.all([
    bookingsBetween(mentorId, menteeId).get(),
    reviews().doc(mentorReviewIdFor(mentorId, menteeId)).get(),
  ]);
  return {
    eligible: latestFinished(sessions.docs, new Date()) !== null,
    rating: review.exists ? Number(review.data()!.rating) : null,
    body: review.exists ? ((review.data()!.body as string | null) ?? null) : null,
  };
}

/**
 * Creates or updates a mentee's review of a mentor.
 *
 * The eligibility read is inside the transaction, as the PAID-order read is
 * for notes: a booking cancelled while the review is being written aborts and
 * re-runs it rather than letting a review land on a session that never was.
 */
export async function upsertMentorReview(p: {
  mentorId: string;
  menteeId: string;
  rating: number;
  body: string | null;
}): Promise<{ ratingAvg: number; ratingCount: number; rating: number; body: string | null }> {
  const db = adminDb();
  const mentorRef = mentors().doc(p.mentorId);
  const reviewRef = reviews().doc(mentorReviewIdFor(p.mentorId, p.menteeId));

  return db.runTransaction(async (tx) => {
    const sessions = await tx.get(bookingsBetween(p.mentorId, p.menteeId));
    const [mentorSnap, reviewSnap] = await tx.getAll(mentorRef, reviewRef);

    if (!mentorSnap.exists || !mentorSnap.data()!.isApproved) {
      throw new MentorReviewError('errors.notFound', 404);
    }
    const mentor = mentorSnap.data()!;
    if (mentor.userId === p.menteeId) throw new MentorReviewError('mentors.reviewForm.errors.self', 403);

    const now = new Date();
    const bookingId = latestFinished(sessions.docs, now);
    if (!bookingId) throw new MentorReviewError('mentors.reviewForm.errors.sessionRequired', 403);

    const previous = reviewSnap.exists ? Number(reviewSnap.data()!.rating) : null;
    const prevCount = Number(mentor.ratingCount ?? 0);
    const prevSum = Number(mentor.ratingSum ?? Number(mentor.ratingAvg ?? 0) * prevCount);
    const ratingCount = prevCount + (previous === null ? 1 : 0);
    const ratingSum = prevSum - (previous ?? 0) + p.rating;
    const ratingAvg = Math.round((ratingSum / ratingCount) * 100) / 100;

    tx.set(reviewRef, {
      mentorId: p.mentorId,
      menteeId: p.menteeId,
      bookingId,
      rating: p.rating,
      body: p.body,
      createdAt: reviewSnap.data()?.createdAt ?? now,
      updatedAt: now,
    });
    tx.update(mentorRef, { ratingSum, ratingCount, ratingAvg, updatedAt: now });
    return { ratingAvg, ratingCount, rating: p.rating, body: p.body };
  });
}

export async function listReviewsForMentor(
  mentorId: string,
  take = 10,
): Promise<MentorReviewRecord[]> {
  const snap = await reviews().where('mentorId', '==', mentorId).limit(100).get();
  return sortBy(
    docsToObjects<MentorReviewRecord>(snap.docs) as MentorReviewRecord[],
    'createdAt',
    'desc',
  ).slice(0, take);
}

export const mentorCollections = { mentors, bookings, reviews, rules, exceptions };
