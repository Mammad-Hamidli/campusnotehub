import { CalendarClock, Info } from 'lucide-react';
import type { BillingSnapshot, BillingUrgency } from '@/lib/mentors/billing';
import type { Locale } from '@/lib/i18n/dictionaries';
import { formatCalendarDate, type Translate } from './format';

const URGENCY_TONE: Record<BillingUrgency, string> = {
  // Yellow is too light for white text; the ring is what sets "today" apart.
  today: 'bg-warn-soft text-warn-fg ring-1 ring-warn/60',
  soon: 'bg-warn-soft text-warn-fg',
  upcoming: 'bg-surface-inset text-fg-muted',
};

/**
 * The monthly membership fee reminder. INFORMATIONAL ONLY.
 *
 * The fee is paid to CampusNoteHub outside the platform, so this card has no
 * button, no amount owed and no paid/overdue state: it shows the join date,
 * the next due date and how far away it is, and says plainly where payment
 * happens. See src/lib/mentors/billing.ts for the date rules.
 *
 * A Server Component (see ./format.ts): the dates are formatted on the
 * server and arrive as text.
 */
export function PaymentReminderCard({
  billing,
  locale,
  t,
}: {
  billing: BillingSnapshot;
  locale: Locale;
  t: Translate;
}) {
  const countdown =
    billing.daysLeft === 0
      ? t('mentorDashboard.fee.dueToday')
      : billing.daysLeft === 1
        ? t('mentorDashboard.fee.dueTomorrow')
        : t('mentorDashboard.fee.dueInDays', { count: billing.daysLeft });

  return (
    <section className="card p-5" aria-labelledby="fee-reminder-title">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
          <CalendarClock className="h-4 w-4 text-accent" aria-hidden="true" />
        </span>
        <h2 id="fee-reminder-title" className="text-sm font-semibold text-fg">
          {t('mentorDashboard.fee.title')}
        </h2>
      </div>

      <dl className="mt-4 space-y-3">
        <div>
          <dt className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
            {t('mentorDashboard.fee.nextDue')}
          </dt>
          <dd className="mt-0.5 text-lg font-semibold tracking-tight text-fg">
            <time dateTime={billing.nextDueOn}>{formatCalendarDate(billing.nextDueOn, locale)}</time>
          </dd>
          <dd className="mt-1.5">
            <span
              className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${URGENCY_TONE[billing.urgency]}`}
            >
              {countdown}
            </span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-edge pt-3">
          <dt className="text-xs text-fg-muted">{t('mentorDashboard.fee.joined')}</dt>
          <dd className="text-sm font-medium text-fg">
            <time dateTime={billing.joinedOn}>{formatCalendarDate(billing.joinedOn, locale)}</time>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-xs text-fg-muted">{t('mentorDashboard.fee.cycle')}</dt>
          <dd className="text-sm font-medium text-fg">{t('mentorDashboard.fee.cycleValue', { count: billing.cycle })}</dd>
        </div>
      </dl>

      <p className="mt-4 flex items-start gap-2 rounded-lg bg-surface-muted p-3 text-xs leading-relaxed text-fg-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{t('mentorDashboard.fee.disclaimer')}</span>
      </p>
    </section>
  );
}
