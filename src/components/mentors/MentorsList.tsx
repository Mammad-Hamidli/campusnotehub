'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BadgeCheck, Briefcase, GraduationCap, Search, ShieldAlert, Star, UserRoundSearch, Video } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { SectionHeading } from '@/components/ui/SectionHeading';

/**
 * The PocketMentor directory.
 *
 * Built to the same standard as the UniNotes list it sits beside - real data,
 * real loading/empty/error states, no seeded placeholder mentors - but to
 * PocketMentor's own logic rather than by copying the marketplace's.
 *
 * The one product rule worth stating here: browsing is open to everyone,
 * BOOKING requires a verified identity. That is `mentors:browse` vs
 * `mentors:book` in src/lib/permissions.ts, and it exists because a booking
 * puts a stranger in a one-to-one call with a student. The server tells us
 * which side of that line the reader is on via `viewerCanBook`, so the card
 * shows the right control instead of offering a button that would be refused.
 */

type Mentor = {
  id: string;
  industry: string;
  specialties: string[];
  headline: string;
  company: string | null;
  jobTitle: string | null;
  yearsExperience: number;
  languages: string[];
  hourlyRateMinor: number;
  sessionMinutes: number;
  isAcceptingBookings: boolean;
  ratingAvg: number;
  ratingCount: number;
  sessionsCompleted: number;
  user: {
    nickname: string;
    avatarUrl: string | null;
    isVerified: boolean;
    university: { code: string } | null;
  };
};

/**
 * Mirrors the MentorIndustry enum in prisma/schema.prisma exactly.
 *
 * Written out rather than imported because pulling a server module into a
 * client component pulls the query engine types into the browser bundle. The
 * server re-validates every value against the real enum, so a drift here costs
 * a rejected filter rather than bad data - but it MUST match, or the dropdown
 * offers filters that return nothing.
 */
const INDUSTRIES = [
  'IT',
  'MARKETING',
  'LAW',
  'ENGINEERING',
  'FINANCE',
  'MEDICINE',
  'EDUCATION',
  'DESIGN',
  'OTHER',
] as const;

function initialsOf(nickname: string): string {
  return nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

/** Money is stored in qepik (minor units); never format from a float. */
function formatPrice(minor: number, locale: string): string | null {
  if (minor <= 0) return null;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'AZN' }).format(minor / 100);
}

/** `embedded` drops the page gutter and demotes the heading, for the dashboard tab. */
export function MentorsList({ embedded = false }: { embedded?: boolean } = {}) {
  const Heading = embedded ? 'h2' : 'h1';
  const t = useT();

  const [mentors, setMentors] = useState<Mentor[]>([]);
  const [canBook, setCanBook] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [industry, setIndustry] = useState('');
  const [university, setUniversity] = useState('');
  const [minYears, setMinYears] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [acceptingOnly, setAcceptingOnly] = useState(false);
  const [universities, setUniversities] = useState<string[]>([]);

  // Universities come from the database, so the filter tracks the admin panel.
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/universities', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { universities: [] }))
      .then((d: { universities: { code: string }[] }) => setUniversities(d.universities.map((u) => u.code)))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'az' : 'az';

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        if (industry) params.set('industry', industry);
        if (university) params.set('university', university);
        if (minYears) params.set('minYears', minYears);
        if (maxPrice) params.set('maxPrice', maxPrice);
        if (acceptingOnly) params.set('accepting', '1');

        const response = await fetch(`/api/mentors?${params.toString()}`, { signal });
        if (!response.ok) {
          setError('mentors.loadFailed');
          return;
        }
        const data = await response.json();
        setMentors(data.mentors ?? []);
        setCanBook(Boolean(data.viewerCanBook));
        setSignedIn(Boolean(data.viewerSignedIn));
      } catch (cause) {
        if ((cause as Error)?.name === 'AbortError') return;
        setError('mentors.loadFailed');
      } finally {
        setLoading(false);
      }
    },
    [query, industry, university, minYears, maxPrice, acceptingOnly],
  );

  /**
   * Debounced so typing a search does not fire a request per keystroke. The
   * industry filter goes through the same timer, which costs it 300ms and
   * saves a second code path.
   */
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  return (
    <div className={embedded ? 'w-full' : 'mx-auto w-full max-w-5xl px-4 py-8 sm:px-6'}>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          as={Heading}
          icon={GraduationCap}
          tone="text-verified bg-verified-soft"
          title={t('mentors.title')}
          subtitle={t('mentors.subtitle')}
        />
        <Link href="/mentors/apply" className="btn-secondary shrink-0 px-3 py-1.5 text-sm">
          <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
          {t('mentors.becomeMentor')}
        </Link>
      </header>

      {/* Browsing is open; only booking is gated. Saying so up front beats
          letting someone pick a mentor and meet the refusal at the end. */}
      {signedIn && !canBook && (
        <p className="card mb-3 flex items-start gap-2 border-warn/30 bg-warn-soft p-3 text-sm text-warn-fg">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('mentors.verifiedOnly')}
        </p>
      )}

      <div className="card mb-4 flex flex-wrap items-end gap-2 p-3">
        <label className="w-full min-w-0 flex-1 basis-56">
          <span className="sr-only">{t('mentors.searchPlaceholder')}</span>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('mentors.searchPlaceholder')}
              className="input py-1.5 pl-9 text-sm"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.industry')}</span>
          <select
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="input py-1.5 text-sm"
          >
            <option value="">{t('mentors.allIndustries')}</option>
            {INDUSTRIES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.filters.university')}</span>
          <select value={university} onChange={(e) => setUniversity(e.target.value)} className="input py-1.5 text-sm">
            <option value="">{t('mentors.filters.allUniversities')}</option>
            {universities.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.filters.experience')}</span>
          <select value={minYears} onChange={(e) => setMinYears(e.target.value)} className="input py-1.5 text-sm">
            <option value="">{t('mentors.filters.anyExperience')}</option>
            {[1, 3, 5, 10].map((years) => (
              <option key={years} value={years}>
                {t('mentors.filters.yearsPlus', { years })}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.filters.price')}</span>
          <select value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className="input py-1.5 text-sm">
            <option value="">{t('mentors.filters.anyPrice')}</option>
            <option value="0">{t('mentors.free')}</option>
            {[1000, 2500, 5000].map((minor) => (
              <option key={minor} value={minor}>
                {t('mentors.filters.upTo', { price: String(minor / 100) + ' ₼' })}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 self-center pt-4 text-sm text-fg-muted">
          <input type="checkbox" checked={acceptingOnly} onChange={(e) => setAcceptingOnly(e.target.checked)} />
          {t('mentors.filters.acceptingOnly')}
        </label>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card h-44 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-fg-muted">{t(error)}</p>
          <button type="button" onClick={() => void load()} className="btn-secondary mt-3 px-3 py-1.5 text-sm">
            {t('common.retry')}
          </button>
        </div>
      ) : mentors.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft">
            <UserRoundSearch className="h-6 w-6 text-accent" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-fg">{t('mentors.empty')}</h2>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
            {t('mentors.emptyHint')}
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {mentors.map((mentor) => {
            const price = formatPrice(mentor.hourlyRateMinor, locale);
            return (
              <li key={mentor.id} className="card flex flex-col p-4">
                <div className="flex items-start gap-3">
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-inset text-xs font-bold text-accent"
                    aria-hidden="true"
                  >
                    {initialsOf(mentor.user.nickname)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-1.5">
                      <span className="truncate text-sm font-medium text-fg">
                        @{mentor.user.nickname}
                      </span>
                      {mentor.user.isVerified && (
                        <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
                      )}
                      {mentor.user.university && (
                        <span className="rounded-md bg-surface-inset px-1.5 py-0.5 text-2xs font-semibold text-fg-muted">
                          {mentor.user.university.code}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-muted">
                      {mentor.headline}
                    </p>
                    {(mentor.jobTitle || mentor.company) && (
                      <p className="mt-1 flex min-w-0 items-center gap-1 text-2xs text-fg-subtle">
                        <Briefcase className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">
                          {[mentor.jobTitle, mentor.company].filter(Boolean).join(' · ')}
                        </span>
                      </p>
                    )}
                  </div>
                </div>

                {mentor.specialties.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {mentor.specialties.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="badge-accent"
                      >
                        {tag}
                      </span>
                    ))}
                    {mentor.specialties.length > 3 && (
                      <span className="text-2xs text-fg-subtle">
                        +{mentor.specialties.length - 3}
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-muted">
                  {mentor.ratingCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Star className="h-3 w-3 fill-current text-warn" aria-hidden="true" />
                      <span className="tabular font-medium text-fg">
                        {mentor.ratingAvg.toFixed(1)}
                      </span>
                      <span>({mentor.ratingCount})</span>
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Video className="h-3 w-3" aria-hidden="true" />
                    {t('mentors.sessions', { count: mentor.sessionsCompleted })}
                  </span>
                  <span className="ml-auto font-medium text-fg">
                    {price ? t('mentors.rate', { price }) : t('mentors.free')}
                  </span>
                </div>

                <div className="mt-3 flex gap-2 border-t border-edge pt-3">
                  {/* Booking is offered only when the server said this viewer
                      may book AND the mentor is open to it. Anything else gets
                      the message action, which is available to any live
                      account and is a genuinely useful fallback. */}
                  {canBook && mentor.isAcceptingBookings ? (
                    <Link
                      href={`/mentors/${mentor.id}`}
                      className="btn-primary flex-1 justify-center px-3 py-1.5 text-sm"
                    >
                      {t('mentors.book')}
                    </Link>
                  ) : (
                    <Link
                      href={`/mentors/${mentor.id}`}
                      className="btn-secondary flex-1 justify-center px-3 py-1.5 text-sm"
                    >
                      {t('mentors.viewProfile')}
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
