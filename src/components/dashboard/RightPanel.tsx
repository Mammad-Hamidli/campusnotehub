'use client';

import Link from 'next/link';
import { ArrowUpRight, CalendarClock, Flame, GraduationCap, Star, TrendingUp } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * Graduation countdown.
 *
 * This widget is the visible half of the lifecycle automation described in
 * src/lib/lifecycle.ts. When verification succeeds, a single LifecycleTask row
 * is written with a dedupe key, scheduled for the FIRST day of the graduation
 * month — not a monthly cron scan across the whole user table.
 *
 * Why the first of the month rather than after it: in Azerbaijan, thesis
 * defence and diploma issuance run through June, so a student prompted on
 * 1 May is prompted while the date still means something to them and can push
 * it back with "still studying" (which reschedules +1 year rather than
 * cancelling — a cancelled prompt leaves the account a "student" forever,
 * which is the exact problem the feature exists to solve).
 */
export function GraduationCountdown({
  year,
  month,
}: {
  year: number;
  /** 1-12 */
  month: number;
}) {
  const t = useT();

  const target = new Date(Date.UTC(year, month - 1, 1));
  const now = new Date();
  const msLeft = target.getTime() - now.getTime();
  const daysLeft = Math.max(0, Math.ceil(msLeft / 86_400_000));
  const monthsLeft = Math.max(0, Math.round(daysLeft / 30.44));

  // Progress across a nominal 4-year degree, so the ring means something on
  // day one instead of sitting at 0%.
  const totalDays = 4 * 365;
  const progress = Math.min(100, Math.max(0, ((totalDays - daysLeft) / totalDays) * 100));

  const monthLabel = String(month).padStart(2, '0');
  const useDays = daysLeft <= 60;

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-edge px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface/10">
            <GraduationCap className="h-[1.15rem] w-[1.15rem] text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-snug text-fg">
              {t('dashboard.graduation.title')}
            </h2>
            <p className="tabular mt-1 text-xl font-medium text-fg">
              {useDays
                ? t('dashboard.graduation.days', { count: daysLeft })
                : t('dashboard.graduation.months', { count: monthsLeft })}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-surface/10"
            role="progressbar"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('dashboard.graduation.title')}
          >
            <div
              className="h-full rounded-full bg-accent
 transition-[width] duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      <div className="p-4">
        <p className="text-xs leading-relaxed text-fg-muted">
          {t('dashboard.graduation.body', { month: monthLabel, year })}
        </p>
        <Link
          href="/settings"
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-accent
 transition hover:text-accent"
        >
          <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
          {t('dashboard.graduation.cta')}
        </Link>
      </div>
    </section>
  );
}

export type TrendingNote = {
  id: string;
  title: string;
  subject: string;
  university: string;
  priceMinor: number;
  rating: number;
  purchases: number;
};

/**
 * BACKEND INTEGRATION
 * -------------------
 *   GET /api/notes?sort=popular&limit=4&window=7d
 *
 * Serve from a materialised view refreshed every 15 minutes rather than an
 * ORDER BY on a live purchase count — this is a sidebar widget and must never
 * be able to slow the feed down.
 */
export function TrendingNotes({ notes }: { notes: TrendingNote[] }) {
  const t = useT();

  const price = (minor: number) =>
    minor === 0 ? t('notes.card.free') : `${(minor / 100).toFixed(2)} ₼`;

  return (
    <section className="card p-4">
      <header className="mb-3.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <TrendingUp className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            {t('dashboard.trending.title')}
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">{t('dashboard.trending.subtitle')}</p>
        </div>
      </header>

      <ul className="space-y-1">
        {notes.map((note, index) => (
          <li key={note.id}>
            <Link
              // There is no per-note page; the listing is where a note is
              // previewed and bought.
              href="/notes"
              className="group flex gap-3 rounded-lg p-2 transition hover:bg-surface-muted"
            >
              <span
                className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-md
 bg-surface-inset text-xs font-bold text-fg-muted
                           group-hover:bg-accent group-hover:text-accent-fg"
                aria-hidden="true"
              >
                {index + 1}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">
                  {note.title}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-muted">
                  <span className="truncate">{note.subject}</span>
                  <span className="rounded bg-surface-inset px-1 font-semibold">{note.university}</span>
                  <span className="flex items-center gap-0.5">
                    <Star className="h-2.5 w-2.5 fill-amber-400 text-warn" aria-hidden="true" />
                    {note.rating.toFixed(1)}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <Flame className="h-2.5 w-2.5 text-warn" aria-hidden="true" />
                    {note.purchases}
                  </span>
                </span>
              </span>

              <span className="shrink-0 self-center text-xs font-semibold text-fg">
                {price(note.priceMinor)}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href="/dashboard?tab=notes"
        className="mt-3 flex items-center justify-center gap-1 rounded-lg border border-edge
 py-2 text-xs font-semibold text-fg-muted transition
                   hover:border-edge hover:bg-surface-muted"
      >
        {t('dashboard.trending.viewAll')}
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </section>
  );
}
