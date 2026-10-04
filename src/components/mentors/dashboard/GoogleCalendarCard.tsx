import { CalendarCheck2, CalendarX2 } from 'lucide-react';
import { CalendarConnection } from './CalendarConnection';
import type { Translate } from './format';

/** Outcomes the OAuth callback can send back to the panel (see oauth/http.ts). */
const NOTICES: Record<string, { key: string; tone: 'ok' | 'bad' }> = {
  connected: { key: 'mentors.calendar.notice.connected', tone: 'ok' },
  cancelled: { key: 'mentors.calendar.notice.cancelled', tone: 'bad' },
  calendar_scope_missing: { key: 'mentors.calendar.notice.scopeMissing', tone: 'bad' },
  expired: { key: 'mentors.calendar.notice.failed', tone: 'bad' },
  failed: { key: 'mentors.calendar.notice.failed', tone: 'bad' },
  forbidden: { key: 'mentors.calendar.notice.failed', tone: 'bad' },
  rate_limited: { key: 'errors.rateLimited', tone: 'bad' },
};

/**
 * Google Calendar: where accepted sessions get their Google Meet room. A
 * mentor must connect it before they can accept a request. Shows which
 * account is connected (masked), and says plainly when Google has revoked
 * access and sessions are waiting for a reconnect.
 */
export function GoogleCalendarCard({
  link,
  notice,
  t,
}: {
  link: { status: 'ACTIVE' | 'REVOKED'; accountHint: string | null } | null;
  notice: string | null;
  t: Translate;
}) {
  const active = link?.status === 'ACTIVE';
  const shown = notice ? NOTICES[notice] : undefined;

  return (
    <section id="calendar" className="card scroll-mt-6 p-5" aria-labelledby="calendar-title">
      <div className="flex items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-verified-soft text-verified' : 'bg-warn-soft text-warn'}`}
          aria-hidden="true"
        >
          {active ? <CalendarCheck2 className="h-4 w-4" /> : <CalendarX2 className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <h2 id="calendar-title" className="text-sm font-semibold text-fg">
            {t('mentors.calendar.title')}
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            {active
              ? link.accountHint
                ? t('mentors.calendar.connectedAs', { account: link.accountHint })
                : t('mentors.calendar.connected')
              : link?.status === 'REVOKED'
                ? t('mentors.calendar.revoked')
                : t('mentors.calendar.notConnected')}
          </p>
        </div>
      </div>

      {shown && (
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-xs ${shown.tone === 'ok' ? 'bg-verified-soft text-verified-fg' : 'bg-warn-soft text-warn-fg'}`}
          role="status"
        >
          {t(shown.key)}
        </p>
      )}

      <p className="mt-3 text-2xs leading-relaxed text-fg-subtle">{t('mentors.calendar.explainer')}</p>
      <CalendarConnection connected={active} />
    </section>
  );
}
