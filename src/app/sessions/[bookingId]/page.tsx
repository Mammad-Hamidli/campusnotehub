import type { Metadata } from 'next';
import Link from 'next/link';
import { BackLink } from '@/components/ui/BackLink';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { CalendarClock } from 'lucide-react';
import { requirePageSession } from '@/lib/auth/page-guard';
import { findBookingById, mentorUserIdOf } from '@/lib/firebase/repositories/mentors';
import { findUserById } from '@/lib/firebase/repositories/users';
import { findCalendarLink } from '@/lib/firebase/repositories/calendarLinks';
import { DEFAULT_LOCALE, DICTIONARIES, LOCALE_COOKIE, isLocale, translate } from '@/lib/i18n/dictionaries';
import { answerDeadline, isLapsedRequest, JOINABLE_STATUSES, joinState, joinWindow } from '@/lib/mentors/requests';
import { formatSessionTime } from '@/components/mentors/dashboard/format';
import { JoinButton } from '@/components/mentors/JoinButton';
import { SessionRequestActions } from '@/components/mentors/SessionRequestActions';

export const metadata: Metadata = { title: 'Session', robots: { index: false, follow: false } };
/** One booking's live state for one of its two participants; never cached. */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  REQUESTED: 'bg-accent-soft text-accent',
  CONFIRMED: 'bg-verified-soft text-verified-fg',
  RESCHEDULED: 'bg-warn-soft text-warn-fg',
  REJECTED: 'bg-danger-soft text-danger',
  EXPIRED: 'bg-surface-inset text-fg-muted',
};
const JOIN_NOTICES = new Set(['early', 'closed', 'pending', 'rate_limited']);

type Props = {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ join?: string }>;
};

/**
 * A session, as its mentor or its mentee sees it - where every email and
 * notification about it links.
 *
 *   REQUESTED  mentee: waiting, and until when; mentor: Accept / Decline
 *   REJECTED   the mentor's reason
 *   EXPIRED    nobody answered in time
 *   CONFIRMED  the join button, live from 30 minutes before the start
 *
 * Only the two participants can open it; anyone else gets the 404 a
 * nonexistent id gets, so ids reveal nothing. The Meet link itself is never
 * on this page - the button goes through GET /api/bookings/:id/join, which
 * re-checks all of this and the time.
 *
 * Server-rendered in the viewer's language and time zone (format.ts explains
 * why dates are never formatted in the browser here).
 */
export default async function SessionPage({ params, searchParams }: Props) {
  const [{ bookingId }, { join }] = await Promise.all([params, searchParams]);
  const viewer = await requirePageSession(`/sessions/${bookingId}`);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) notFound();

  const booking = await findBookingById(bookingId);
  if (!booking) notFound();
  const mentorUserId = await mentorUserIdOf(booking);
  const role = booking.menteeId === viewer.id ? 'mentee' : mentorUserId === viewer.id ? 'mentor' : null;
  if (!role) notFound();

  const otherId = role === 'mentee' ? mentorUserId : booking.menteeId;
  const [me, other, calendar] = await Promise.all([
    findUserById(viewer.id),
    otherId ? findUserById(otherId) : null,
    role === 'mentor' ? findCalendarLink(viewer.id) : null,
  ]);

  const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const dict = DICTIONARIES[locale];
  const t = (key: string, p?: Record<string, string | number>) => translate(dict, key, p);
  const timeZone = me?.timezone || booking.timezone || 'Asia/Baku';
  const at = (instant: Date) => formatSessionTime(instant, locale, timeZone);

  const now = new Date();
  const status = isLapsedRequest(booking, now) ? 'EXPIRED' : booking.status;
  const minutes = Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000);
  const { opensAt, closesAt } = joinWindow(booking);
  const otherName = other && !other.deletedAt ? other.nickname : null;

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        <BackLink fallbackHref={role === 'mentor' ? '/mentors/dashboard' : '/notifications'} />

        <section className="card mt-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-bold tracking-tight text-fg">{booking.topic}</h1>
              {otherName && (
                <p className="mt-1 text-sm text-fg-muted">
                  {t(role === 'mentor' ? 'sessions.withMentee' : 'sessions.withMentor')}{' '}
                  <Link href={`/u/${otherName}`} className="font-medium text-fg hover:underline">
                    @{otherName}
                  </Link>
                </p>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-2xs font-semibold ${STATUS_TONE[status] ?? 'bg-surface-inset text-fg-muted'}`}
            >
              {t(`sessions.status.${status in STATUS_TONE ? status : 'OTHER'}`)}
            </span>
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-2xs font-medium text-fg-subtle">{t('sessions.when')}</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 text-fg">
                <CalendarClock className="h-4 w-4 text-fg-muted" aria-hidden="true" />
                <time dateTime={booking.startsAt.toISOString()}>{at(booking.startsAt)}</time>
              </dd>
            </div>
            <div>
              <dt className="text-2xs font-medium text-fg-subtle">{t('sessions.length')}</dt>
              <dd className="mt-0.5 text-fg">{t('sessions.minutes', { count: minutes })}</dd>
            </div>
          </dl>
          <p className="mt-2 text-2xs text-fg-subtle">{t('sessions.timezone', { timezone: timeZone })}</p>

          {booking.menteeNote && (
            <div className="mt-4 rounded-lg bg-surface-muted p-3">
              <p className="text-2xs font-medium text-fg-subtle">{t('sessions.menteeNote')}</p>
              <p className="mt-1 whitespace-pre-line text-sm text-fg">{booking.menteeNote}</p>
            </div>
          )}
        </section>

        {status === 'REQUESTED' && (
          <section className="card mt-4 p-5">
            {role === 'mentor' ? (
              <>
                <h2 className="text-sm font-semibold text-fg">{t('sessions.requested.mentorTitle')}</h2>
                <p className="mt-1 text-sm text-fg-muted">
                  {t('mentors.requests.answerBy', { when: at(answerDeadline(booking)) })}
                </p>
                <SessionRequestActions bookingId={booking.id} calendarConnected={calendar?.status === 'ACTIVE'} />
              </>
            ) : (
              <>
                <h2 className="text-sm font-semibold text-fg">{t('sessions.requested.menteeTitle')}</h2>
                <p className="mt-1 text-sm text-fg-muted">
                  {t('sessions.requested.menteeBody', { when: at(answerDeadline(booking)) })}
                </p>
              </>
            )}
          </section>
        )}

        {status === 'REJECTED' && (
          <section className="card mt-4 p-5">
            <h2 className="text-sm font-semibold text-fg">{t('sessions.rejected.title')}</h2>
            {booking.rejectionReason && (
              <blockquote className="mt-2 whitespace-pre-line border-l-2 border-danger/40 pl-3 text-sm text-fg">
                {booking.rejectionReason}
              </blockquote>
            )}
            {role === 'mentee' && (
              <Link href={`/mentors/${booking.mentorId}`} className="btn-secondary mt-4 px-3.5 py-1.5 text-sm">
                {t('sessions.findAnotherTime')}
              </Link>
            )}
          </section>
        )}

        {status === 'EXPIRED' && (
          <section className="card mt-4 p-5">
            <h2 className="text-sm font-semibold text-fg">{t('sessions.expired.title')}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t('sessions.expired.body')}</p>
            {role === 'mentee' && (
              <Link href={`/mentors/${booking.mentorId}`} className="btn-secondary mt-4 px-3.5 py-1.5 text-sm">
                {t('sessions.findAnotherTime')}
              </Link>
            )}
          </section>
        )}

        {JOINABLE_STATUSES.has(status) && (
          <section className="card mt-4 p-5" aria-labelledby="join-title">
            <h2 id="join-title" className="text-sm font-semibold text-fg">
              {t('sessions.join.title')}
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              {t(role === 'mentor' ? 'sessions.join.mentorHint' : 'sessions.join.menteeHint')}
            </p>

            {join && JOIN_NOTICES.has(join) && (
              <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-fg" role="status">
                {t(`sessions.join.notice.${join}`)}
              </p>
            )}

            {booking.meetingStatus === 'NEEDS_CALENDAR' && (
              <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-fg">
                {t(role === 'mentor' ? 'sessions.meeting.needsCalendarMentor' : 'sessions.meeting.needsCalendarMentee')}{' '}
                {role === 'mentor' && (
                  <Link href="/mentors/dashboard#calendar" className="font-medium underline">
                    {t('mentors.requests.connectCalendar')}
                  </Link>
                )}
              </p>
            )}
            {booking.meetingStatus === 'FAILED' && (
              <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {t('sessions.meeting.failed')}
              </p>
            )}

            <div className="mt-4">
              <JoinButton
                href={`/api/bookings/${booking.id}/join`}
                opensAtMs={opensAt.getTime()}
                closesAtMs={closesAt.getTime()}
                initial={joinState(booking, now)}
                labels={{
                  join: t('sessions.join.button'),
                  early: t('sessions.join.opensAt', { when: at(opensAt) }),
                  closed: t('sessions.join.closed'),
                }}
              />
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
