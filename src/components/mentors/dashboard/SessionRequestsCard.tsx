import Link from 'next/link';
import { Inbox } from 'lucide-react';
import type { Locale } from '@/lib/i18n/dictionaries';
import { SessionRequestActions } from '@/components/mentors/SessionRequestActions';
import { formatSessionTime, type Translate } from './format';

export type PendingSessionRequest = {
  id: string;
  startsAt: Date;
  answerBy: Date;
  topic: string;
  menteeNote: string | null;
  mentee: string;
};

/**
 * Requests waiting for the mentor's answer, each with Accept / Decline - the
 * same control the notification carries, here so nothing is missed in a long
 * notification list. Times are formatted on the server (see format.ts).
 */
export function SessionRequestsCard({
  requests,
  calendarConnected,
  locale,
  timeZone,
  t,
}: {
  requests: PendingSessionRequest[];
  calendarConnected: boolean;
  locale: Locale;
  timeZone: string;
  t: Translate;
}) {
  return (
    <section id="requests" className="card scroll-mt-6 p-5" aria-labelledby="session-requests-title">
      <h2 id="session-requests-title" className="text-sm font-semibold text-fg">
        {t('mentorDashboard.requests.title')}{' '}
        {requests.length > 0 && <span className="font-normal text-fg-muted">({requests.length})</span>}
      </h2>

      {requests.length === 0 ? (
        <div className="mt-4 flex flex-col items-center rounded-lg border border-dashed border-edge px-4 py-6 text-center">
          <Inbox className="h-6 w-6 text-fg-subtle" aria-hidden="true" />
          <p className="mt-2 text-sm text-fg-muted">{t('mentorDashboard.requests.empty')}</p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-edge">
          {requests.map((request) => (
            <li key={request.id} className="py-3 first:pt-0 last:pb-0">
              <Link href={`/sessions/${request.id}`} className="block text-sm font-medium text-fg hover:underline">
                {request.topic}
              </Link>
              <p className="mt-0.5 text-xs text-fg-muted">
                @{request.mentee} ·{' '}
                <time dateTime={request.startsAt.toISOString()}>
                  {formatSessionTime(request.startsAt, locale, timeZone)}
                </time>
              </p>
              {request.menteeNote && (
                <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{request.menteeNote}</p>
              )}
              <p className="mt-1 text-2xs text-fg-subtle">
                {t('mentors.requests.answerBy', { when: formatSessionTime(request.answerBy, locale, timeZone) })}
              </p>
              <SessionRequestActions bookingId={request.id} calendarConnected={calendarConnected} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
