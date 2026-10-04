import { NotificationType } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { forFirestore } from '@/lib/firebase/convert';
import {
  findBookingById,
  findMentorByUserId,
  listUpcomingMentorBookings,
  mentorCollections,
  mentorUserIdOf,
  type BookingRecord,
  type MeetingStatus,
} from '@/lib/firebase/repositories/mentors';
import { findUserById } from '@/lib/firebase/repositories/users';
import { schedule } from '@/lib/firebase/repositories/scheduledTasks';
import { openJson, sealJson } from '@/lib/crypto/vault';
import { enqueueNotification } from '@/lib/notifications/dispatch';
import { sendEmailAsync } from '@/lib/email/send';
import { appUrl } from '@/lib/email/urls';
import {
  CalendarApiError,
  CalendarAuthError,
  deleteEvent,
  meetUrlOf,
  upsertMeetEvent,
} from '@/lib/google/calendar';
import { JOINABLE_STATUSES, isMeetUrl } from './requests';
import { meetEventIdFor } from './ids';
import { formatEmailTime } from './email-time';

/**
 * Google Meet rooms for accepted sessions.
 *
 * ===========================================================================
 * WHERE THE ROOM LIVES, AND WHY THE LINK IS GATED HERE
 * ===========================================================================
 * The room is created as an event on the MENTOR's own Google Calendar (they
 * connect it once, from the mentor panel), so the mentor is the meeting's
 * host: they get it in their calendar and they admit their mentee. A
 * platform-owned room would have no host present to admit anyone.
 *
 * Google Meet cannot time-lock a link - a Meet URL is a bearer credential
 * that works whenever it is opened. "Active from 30 minutes before" is
 * therefore enforced by never letting the mentee SEE the link before then:
 *
 *   - the event has no attendees, so Google sends no invitation;
 *   - the URL is sealed at rest (vault, bound to the booking id);
 *   - no email, notification or API response contains it;
 *   - the only thing that opens it is GET /api/bookings/:id/join, which
 *     checks the viewer is a participant and the time is inside the window,
 *     then redirects.
 *
 * Without a host in the room a mentee who arrives early waits in the lobby.
 *
 * ===========================================================================
 * FAILURE IS A STATE, NOT AN ERROR
 * ===========================================================================
 * Accepting a session never fails because Google is slow or down. The booking
 * commits CONFIRMED with meetingStatus PENDING, provisioning runs right after,
 * and anything that goes wrong becomes:
 *
 *   PENDING         retried with backoff (scheduled task), and again by the
 *                   join route the moment someone needs the link
 *   NEEDS_CALENDAR  the mentor's Google access is gone; they are told, and
 *                   reconnecting re-provisions every waiting session
 *   FAILED          retries exhausted; the session page says so
 *
 * Provisioning is idempotent end to end (derived event id and conference
 * request id), so running it twice - a retry racing the join route - is safe.
 */

const MAX_ATTEMPTS = 6;
/** 1, 2, 4, 8, 16 minutes between attempts. */
const retryDelayMs = (attempt: number) => Math.min(16, 2 ** (attempt - 1)) * 60_000;

export type ProvisionResult = MeetingStatus | 'SKIPPED';

const bookingRef = (id: string) => mentorCollections.bookings().doc(id);

export async function provisionMeeting(bookingId: string, attempt = 1): Promise<ProvisionResult> {
  const booking = await findBookingById(bookingId);
  if (!booking || !JOINABLE_STATUSES.has(booking.status) || booking.endsAt <= new Date()) return 'SKIPPED';
  if (booking.meetingStatus === 'READY' && booking.meetingUrlEnc) return 'READY';

  const mentorUserId = await mentorUserIdOf(booking);
  if (!mentorUserId) return 'SKIPPED';

  try {
    const mentee = await findUserById(booking.menteeId);
    const event = await upsertMeetEvent(mentorUserId, {
      eventId: meetEventIdFor(booking.id),
      requestId: `ch-${booking.id}`,
      summary: `CampusNoteHub mentoring: ${booking.topic}`.slice(0, 200),
      description: [
        'Mentoring session booked through CampusNoteHub.',
        mentee ? `Mentee: @${mentee.nickname}` : null,
        `Topic: ${booking.topic}`,
        '',
        'Your mentee joins through CampusNoteHub from 30 minutes before the start and asks to join - admit them from the Meet window.',
        `Session page: ${appUrl(`/sessions/${booking.id}`)}`,
      ]
        .filter((line) => line !== null)
        .join('\n'),
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      timeZone: booking.timezone,
      bookingId: booking.id,
    });

    const url = meetUrlOf(event);
    if (!url) {
      // Google is still creating the conference; read it back shortly.
      await recordFailure(booking.id, attempt, 'conference pending');
      return 'PENDING';
    }
    if (!isMeetUrl(url)) throw new CalendarApiError(502, false, 'conference uri is not a Meet room');

    const sealed = await sealJson({ url }, { bookingId: booking.id });
    const stored = await adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef(booking.id));
      if (!snap.exists || !JOINABLE_STATUSES.has(String(snap.get('status')))) return false;
      tx.update(
        snap.ref,
        forFirestore({
          meetingProvider: 'google_meet',
          meetingStatus: 'READY',
          meetingUrlEnc: sealed,
          calendarEventId: event.id,
          meetingError: null,
          updatedAt: new Date(),
        }),
      );
      return true;
    });
    if (!stored) {
      // Cancelled while the room was being made: take the event back down.
      await deleteEvent(mentorUserId, event.id).catch(() => {});
      return 'SKIPPED';
    }
    return 'READY';
  } catch (error) {
    if (error instanceof CalendarAuthError) {
      await needsCalendar(booking, mentorUserId, error.reason);
      return 'NEEDS_CALENDAR';
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[meeting] provisioning %s failed (attempt %d): %s', booking.id, attempt, message);
    return recordFailure(booking.id, attempt, message);
  }
}

/** Marks the attempt and queues the next one, or gives up after MAX_ATTEMPTS. */
async function recordFailure(bookingId: string, attempt: number, message: string): Promise<MeetingStatus> {
  const status: MeetingStatus = attempt >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
  await setMeetingState(bookingId, status, message);
  if (status === 'PENDING') {
    await schedule({
      kind: 'MEETING_PROVISION',
      runAt: new Date(Date.now() + retryDelayMs(attempt)),
      // One task per attempt: a dedupe key reused across attempts would
      // collide with the already-executed previous one.
      dedupeKey: `MEETING_PROVISION:${bookingId}:${attempt + 1}`,
      payload: { bookingId, attempt: attempt + 1 },
    });
  }
  return status;
}

/** Updates the meeting fields unless the room is already READY. Returns the previous status. */
async function setMeetingState(bookingId: string, status: MeetingStatus, error: string | null) {
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef(bookingId));
    const previous = (snap.get('meetingStatus') as MeetingStatus | null | undefined) ?? null;
    if (!snap.exists || previous === 'READY') return previous;
    tx.update(
      snap.ref,
      forFirestore({ meetingStatus: status, meetingError: error?.slice(0, 300) ?? null, updatedAt: new Date() }),
    );
    return previous;
  });
}

/** The mentor's Google access is unusable: say so once per session, and wait for a reconnect. */
async function needsCalendar(booking: BookingRecord, mentorUserId: string, reason: string): Promise<void> {
  const previous = await setMeetingState(booking.id, 'NEEDS_CALENDAR', `calendar ${reason}`);
  if (previous === 'NEEDS_CALENDAR' || previous === 'READY') return;

  const mentor = await findUserById(mentorUserId);
  if (!mentor || mentor.deletedAt) return;
  await enqueueNotification({
    userId: mentorUserId,
    type: NotificationType.CALENDAR_DISCONNECTED,
    titleKey: 'notifications.calendarDisconnected.title',
    bodyKey: 'notifications.calendarDisconnected.body',
    params: { when: booking.startsAt.toISOString() },
    linkUrl: '/mentors/dashboard#calendar',
    skipEmail: true,
  });
  sendEmailAsync(
    mentor.email,
    'calendarReconnect',
    { nickname: mentor.nickname, when: formatEmailTime(booking.startsAt, mentor.timezone) },
    // One a day per mentor, however many sessions are waiting.
    { dedupeKey: `calendar-reconnect:${mentorUserId}:${new Date().toISOString().slice(0, 10)}` },
  );
}

/**
 * After a (re)connect: every upcoming confirmed session of this mentor that
 * has no room yet gets one. Sequential - a mentor has a handful at most, and
 * a burst of parallel inserts is how a fresh token meets a rate limit.
 */
export async function provisionWaitingMeetings(mentorUserId: string): Promise<void> {
  const profile = await findMentorByUserId(mentorUserId);
  if (!profile) return;
  const waiting = (await listUpcomingMentorBookings(profile.id, new Date())).filter(
    (b) => JOINABLE_STATUSES.has(b.status) && b.meetingStatus !== 'READY',
  );
  for (const booking of waiting) await provisionMeeting(booking.id);
}

/** The room URL, for the join route only. Null when there is none or it fails to open. */
export async function revealMeetingUrl(booking: BookingRecord): Promise<string | null> {
  if (booking.meetingStatus !== 'READY' || !booking.meetingUrlEnc) return null;
  try {
    const { url } = await openJson<{ url: string }>(booking.meetingUrlEnc, { bookingId: booking.id });
    return isMeetUrl(url) ? url : null;
  } catch {
    console.error('[meeting] sealed url for %s did not open', booking.id);
    return null;
  }
}
