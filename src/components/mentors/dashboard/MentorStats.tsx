import { CalendarCheck, Star, Users } from 'lucide-react';
import type { Translate } from './format';

/**
 * Three numbers from the approved profile. Rendered only once a profile
 * exists: before approval every value would be a zero that reads as a
 * verdict rather than as "not live yet".
 *
 * The rating uses toFixed, not Intl, so it cannot depend on ICU data - see
 * ./format.ts.
 */
export function MentorStats({
  sessionsCompleted,
  ratingAvg,
  ratingCount,
  upcoming,
  t,
}: {
  sessionsCompleted: number;
  ratingAvg: number;
  ratingCount: number;
  upcoming: number;
  t: Translate;
}) {
  const tiles = [
    { icon: Users, label: t('mentorDashboard.stats.sessions'), value: String(sessionsCompleted) },
    {
      icon: Star,
      label: t('mentorDashboard.stats.rating'),
      value: ratingCount > 0 ? ratingAvg.toFixed(1) : '—',
      hint: t('mentorDashboard.stats.reviews', { count: ratingCount }),
    },
    { icon: CalendarCheck, label: t('mentorDashboard.stats.upcoming'), value: String(upcoming) },
  ];

  return (
    <section aria-label={t('mentorDashboard.stats.title')} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {tiles.map(({ icon: Icon, label, value, hint }) => (
        <div key={label} className="card p-4">
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{label}</span>
          </p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight text-fg">{value}</p>
          {hint && <p className="mt-0.5 text-2xs text-fg-subtle">{hint}</p>}
        </div>
      ))}
    </section>
  );
}
