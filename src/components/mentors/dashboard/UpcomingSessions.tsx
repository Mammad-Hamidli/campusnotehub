import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import type { Locale } from '@/lib/i18n/dictionaries';
import { formatSessionTime, type Translate } from './format';

export type UpcomingSession = {
  id: string;
  startsAt: Date;
  topic: string;
  status: string;
};

const STATUS_TONE: Record<string, string> = {
  CONFIRMED: 'bg-verified-soft text-verified-fg',
  RESCHEDULED: 'bg-warn-soft text-warn-fg',
  REQUESTED: 'bg-accent-soft text-accent',
};

/**
 * The mentor's next few confirmed sessions, in the mentor's own time zone.
 * Each opens its session page (join button, details); requests waiting for
 * an answer are listed separately (SessionRequestsCard). `live` is false
 * before approval, when there cannot be any bookings yet and the empty state
 * says so instead of "nothing booked".
 */
export function UpcomingSessions({
  sessions,
  live,
  locale,
  timeZone,
  t,
}: {
  sessions: UpcomingSession[];
  live: boolean;
  locale: Locale;
  timeZone: string;
  t: Translate;
}) {
  return (
    <section className="card p-5" aria-labelledby="upcoming-sessions-title">
      <h2 id="upcoming-sessions-title" className="text-sm font-semibold text-fg">
        {t('mentorDashboard.sessions.title')}
      </h2>

      {sessions.length === 0 ? (
        <div className="mt-4 flex flex-col items-center rounded-lg border border-dashed border-edge px-4 py-8 text-center">
          <CalendarDays className="h-6 w-6 text-fg-subtle" aria-hidden="true" />
          <p className="mt-2 text-sm text-fg-muted">
            {t(live ? 'mentorDashboard.sessions.empty' : 'mentorDashboard.sessions.notLive')}
          </p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-edge">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/sessions/${session.id}`}
                  className="block truncate text-sm font-medium text-fg hover:underline"
                >
                  {session.topic}
                </Link>
                <p className="mt-0.5 text-xs text-fg-muted">
                  <time dateTime={session.startsAt.toISOString()}>
                    {formatSessionTime(session.startsAt, locale, timeZone)}
                  </time>
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${STATUS_TONE[session.status] ?? 'bg-surface-inset text-fg-muted'}`}
              >
                {t(`mentorDashboard.sessions.status.${session.status}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
