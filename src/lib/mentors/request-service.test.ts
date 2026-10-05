import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

/**
 * The session-request state machine against an in-memory Firestore: who may
 * answer, what each answer writes (status, the other side's notification,
 * scheduled work, email), and the double-booking checks. Real code from the
 * service down to the repositories; only storage and mail are fake.
 */

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const sendEmail = vi.fn();
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (...args: unknown[]) => {
    sendEmail(...args);
    return { ok: true, id: null };
  },
  sendEmailAsync: () => {},
}));
// Run post-commit work inline so the test can see it.
const background: Promise<unknown>[] = [];
vi.mock('@/lib/after-response', () => ({
  afterResponse: (_label: string, task: () => Promise<unknown>) => void background.push(task()),
}));

const { createSessionRequest, respondToRequest, expireRequest } = await import('./request-service');
const { BookingError } = await import('./availability');
const { bookingIdFor } = await import('./ids');

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR);
const doc = (path: string) => fake.store.get(path) as Record<string, unknown> | undefined;
const docs = (prefix: string) =>
  [...fake.store.entries()].filter(([path]) => path.startsWith(`${prefix}/`)).map(([, data]) => data);
const settle = async () => {
  await Promise.all(background.splice(0));
};

function seed() {
  fake.store.set('mentorProfiles/mp1', { userId: 'mentor', timezone: 'Asia/Baku', sessionMinutes: 60 });
  fake.store.set('mentorProfiles/mp2', { userId: 'mentor2', timezone: 'Asia/Baku', sessionMinutes: 60 });
  for (const [id, nickname] of [
    ['mentor', 'rashad'],
    ['mentor2', 'leyla'],
    ['mentee', 'aysel'],
    ['stranger', 'nobody'],
  ]) {
    fake.store.set(`users/${id}`, { nickname, email: `${id}@ada.edu.az`, timezone: 'Asia/Baku', deletedAt: null });
  }
  fake.store.set('googleCalendarLinks/mentor', { status: 'ACTIVE', scope: 'x', refreshTokenSealed: 'x' });
}

function request(overrides: Partial<Parameters<typeof createSessionRequest>[0]> = {}) {
  const startsAt = overrides.startsAt ?? inHours(72);
  return createSessionRequest({
    mentor: { id: 'mp1', userId: 'mentor', timezone: 'Asia/Baku' },
    menteeId: 'mentee',
    menteeNickname: 'aysel',
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    sessionMinutes: 60,
    topic: 'Interview prep',
    menteeNote: null,
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  });
}

/** A booking written directly, for the states a test needs to start from. */
function existing(id: string, data: Record<string, unknown>) {
  const startsAt = (data.startsAt as Date) ?? inHours(72);
  fake.store.set(`bookings/${id}`, {
    mentorId: 'mp1',
    mentorUserId: 'mentor',
    menteeId: 'mentee',
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    status: 'REQUESTED',
    topic: 'Interview prep',
    menteeNote: null,
    requestExpiresAt: inHours(24),
    ...data,
  });
}

beforeEach(() => {
  fake.store.clear();
  background.length = 0;
  sendEmail.mockClear();
  seed();
});

describe('requesting a session', () => {
  it('holds the slot as REQUESTED and gives the mentor a notification that carries the booking', async () => {
    const { booking, replay } = await request();
    expect(replay).toBe(false);
    expect(booking.status).toBe('REQUESTED');
    expect(doc(`bookings/${booking.id}`)).toMatchObject({ status: 'REQUESTED', mentorUserId: 'mentor' });
    // 48 hours from "now" inside the service; a second of drift allowed.
    const expires = doc(`bookings/${booking.id}`)?.requestExpiresAt as Date;
    expect(Math.abs(expires.getTime() - inHours(48).getTime())).toBeLessThan(1_000);

    const [notification] = docs('notifications');
    expect(notification).toMatchObject({ userId: 'mentor', type: 'BOOKING_REQUESTED' });
    expect((notification.params as Record<string, unknown>).bookingId).toBe(booking.id);
    expect(doc(`scheduledTasks/BOOKING_REQUEST_EXPIRE:${booking.id}`)).toBeDefined();
  });

  it('emails the mentor the details, linking to the request page rather than answering in the mail', async () => {
    const { booking } = await request({ menteeNote: 'Could we look at my CV?' });
    await settle();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      'mentor@ada.edu.az',
      'bookingRequested',
      expect.objectContaining({
        mentee: 'aysel',
        minutes: 60,
        topic: 'Interview prep',
        note: 'Could we look at my CV?',
        path: `/sessions/${booking.id}`,
      }),
      { dedupeKey: `booking-requested:${booking.id}` },
    );
  });

  it('re-sends the request email on a replay, under the same dedupe key', async () => {
    const startsAt = inHours(72);
    const { booking } = await request({ startsAt });
    await request({ startsAt });
    await settle();

    const keys = sendEmail.mock.calls.map((call) => (call[3] as { dedupeKey: string }).dedupeKey);
    expect(keys).toEqual([`booking-requested:${booking.id}`, `booking-requested:${booking.id}`]);
  });

  it('answers a retried submit with the original request instead of a second one', async () => {
    // A real retry resends the same body, so the same instant.
    const startsAt = inHours(72);
    const first = await request({ startsAt });
    const again = await request({ startsAt });
    expect(again.replay).toBe(true);
    expect(again.booking.id).toBe(first.booking.id);
    expect(docs('bookings')).toHaveLength(1);
    expect(docs('notifications')).toHaveLength(1);
  });

  it('refuses the same idempotency key for a different slot', async () => {
    await request();
    await expect(request({ startsAt: inHours(96) })).rejects.toMatchObject({ messageKey: 'mentors.errors.duplicateRequest' });
  });

  it('refuses a slot another booking holds, but not one held by a lapsed request', async () => {
    existing('taken', { menteeId: 'someone', status: 'CONFIRMED' });
    await expect(request()).rejects.toMatchObject({ messageKey: 'mentors.errors.slotTaken' });

    fake.store.delete('bookings/taken');
    existing('lapsed', { menteeId: 'someone', requestExpiresAt: inHours(-1) });
    await expect(request()).resolves.toMatchObject({ replay: false });
  });

  it('refuses a mentee who is already busy at that time with another mentor', async () => {
    existing('elsewhere', { mentorId: 'mp2', mentorUserId: 'mentor2', status: 'CONFIRMED' });
    await expect(request()).rejects.toBeInstanceOf(BookingError);
    await expect(request()).rejects.toMatchObject({ messageKey: 'mentors.errors.menteeBusy' });
  });

  it('caps how many requests one mentee can have waiting', async () => {
    for (let i = 0; i < 5; i++) existing(`p${i}`, { mentorId: `other${i}`, startsAt: inHours(100 + i * 2) });
    await expect(request()).rejects.toMatchObject({ messageKey: 'mentors.errors.tooManyPending' });
  });

  it('refuses a session too close to leave the mentor time to answer', async () => {
    await expect(request({ startsAt: new Date(Date.now() + 70 * 60_000) })).rejects.toMatchObject({
      messageKey: 'mentors.errors.tooSoonToAnswer',
    });
  });
});

describe('answering a request', () => {
  const id = bookingIdFor('mentee', 'k');

  it('RBAC: nobody but the mentor it was sent to can answer it, and the refusal is a 404', async () => {
    existing(id, {});
    for (const actorId of ['stranger', 'mentee', 'mentor2']) {
      await expect(respondToRequest({ bookingId: id, actorId, input: { action: 'reject', reason: 'Not available then.' } }))
        .rejects.toMatchObject({ status: 404, messageKey: 'errors.notFound' });
    }
    expect(doc(`bookings/${id}`)?.status).toBe('REQUESTED');
    expect(docs('notifications')).toHaveLength(0);
  });

  it('falls back to the mentor profile for a booking written before mentorUserId existed', async () => {
    existing(id, { mentorUserId: undefined });
    await expect(respondToRequest({ bookingId: id, actorId: 'mentor', input: { action: 'accept' } })).resolves.toMatchObject({
      outcome: 'CONFIRMED',
    });
  });

  it('accepting confirms, tells the mentee in-app and by email, and queues the Meet room and reminders', async () => {
    existing(id, { startsAt: inHours(72) });
    fake.store.set(`scheduledTasks/BOOKING_REQUEST_EXPIRE:${id}`, { kind: 'BOOKING_REQUEST_EXPIRE' });

    const result = await respondToRequest({ bookingId: id, actorId: 'mentor', input: { action: 'accept' } });
    await settle();

    expect(result.outcome).toBe('CONFIRMED');
    expect(doc(`bookings/${id}`)).toMatchObject({ status: 'CONFIRMED', meetingStatus: 'PENDING' });
    expect(docs('notifications')).toEqual([expect.objectContaining({ userId: 'mentee', type: 'BOOKING_CONFIRMED' })]);
    expect(doc(`scheduledTasks/BOOKING_REQUEST_EXPIRE:${id}`)).toBeUndefined();
    expect(doc(`scheduledTasks/MEETING_PROVISION:${id}:0`)).toBeDefined();
    expect(doc(`scheduledTasks/BOOKING_REMINDER_24H:${id}`)).toBeDefined();
    expect(sendEmail).toHaveBeenCalledWith(
      'mentee@ada.edu.az',
      'bookingConfirmed',
      expect.objectContaining({ mentor: 'rashad', path: `/sessions/${id}` }),
      { dedupeKey: `booking-confirmed:${id}` },
    );
  });

  it('accepting needs a connected Google Calendar, and writes nothing without one', async () => {
    existing(id, {});
    fake.store.set('googleCalendarLinks/mentor', { status: 'REVOKED' });
    await expect(respondToRequest({ bookingId: id, actorId: 'mentor', input: { action: 'accept' } })).rejects.toMatchObject({
      status: 409,
      messageKey: 'mentors.requests.errors.calendarRequired',
    });
    expect(doc(`bookings/${id}`)?.status).toBe('REQUESTED');
  });

  it('accepting re-checks the mentee: a session confirmed elsewhere meanwhile blocks it', async () => {
    existing(id, {});
    existing('elsewhere', { mentorId: 'mp2', mentorUserId: 'mentor2', status: 'CONFIRMED' });
    await expect(respondToRequest({ bookingId: id, actorId: 'mentor', input: { action: 'accept' } })).rejects.toMatchObject({
      messageKey: 'mentors.requests.errors.menteeBusy',
    });
    expect(doc(`bookings/${id}`)?.status).toBe('REQUESTED');
  });

  it('declining stores the reason and sends it to the mentee', async () => {
    existing(id, {});
    const reason = 'I am travelling that week, sorry.';
    const result = await respondToRequest({ bookingId: id, actorId: 'mentor', input: { action: 'reject', reason } });
    await settle();

    expect(result.outcome).toBe('REJECTED');
    expect(doc(`bookings/${id}`)).toMatchObject({ status: 'REJECTED', rejectionReason: reason });
    expect(docs('notifications')).toEqual([expect.objectContaining({ userId: 'mentee', type: 'BOOKING_REJECTED' })]);
    expect(sendEmail).toHaveBeenCalledWith('mentee@ada.edu.az', 'bookingRejected', expect.objectContaining({ reason }), {
      dedupeKey: `booking-rejected:${id}`,
    });
  });

  it('a second answer is refused - a stale button cannot flip a decision', async () => {
    existing(id, { status: 'CONFIRMED' });
    await expect(
      respondToRequest({ bookingId: id, actorId: 'mentor', input: { action: 'reject', reason: 'Changed my mind.' } }),
    ).rejects.toMatchObject({ status: 409, messageKey: 'mentors.requests.errors.alreadyAnswered' });
    expect(doc(`bookings/${id}`)?.status).toBe('CONFIRMED');
  });

  it('answering after the deadline closes the request as EXPIRED instead', async () => {
    existing(id, { requestExpiresAt: inHours(-1) });
    const result = await respondToRequest({ bookingId: id, actorId: 'mentor', input: { action: 'accept' } });
    expect(result.outcome).toBe('EXPIRED');
    expect(doc(`bookings/${id}`)?.status).toBe('EXPIRED');
    expect(docs('notifications')).toEqual([expect.objectContaining({ userId: 'mentee', type: 'BOOKING_EXPIRED' })]);
  });
});

describe('expiry task', () => {
  it('closes a lapsed request once, and leaves a live or answered one alone', async () => {
    existing('lapsed', { requestExpiresAt: inHours(-1) });
    existing('live', { startsAt: inHours(200) });
    existing('answered', { status: 'CONFIRMED', requestExpiresAt: inHours(-1), startsAt: inHours(300) });

    expect(await expireRequest('lapsed')).toBe(true);
    expect(await expireRequest('lapsed')).toBe(false);
    expect(await expireRequest('live')).toBe(false);
    expect(await expireRequest('answered')).toBe(false);
    await settle();

    expect(doc('bookings/lapsed')?.status).toBe('EXPIRED');
    expect(doc('bookings/live')?.status).toBe('REQUESTED');
    expect(doc('bookings/answered')?.status).toBe('CONFIRMED');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith('mentee@ada.edu.az', 'bookingExpired', expect.anything(), expect.anything());
  });

  it('treats an unknown booking as nothing to do', async () => {
    expect(await expireRequest('missing')).toBe(false);
  });
});
