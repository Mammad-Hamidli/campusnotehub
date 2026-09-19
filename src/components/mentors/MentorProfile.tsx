'use client';

import { useCallback, useEffect, useState } from 'react';
import { MentorReviewForm, type ViewerReview } from './MentorReviewForm';
import Link from 'next/link';
import {
  ArrowLeft,
  BadgeCheck,
  Briefcase,
  CalendarClock,
  Clock,
  Globe,
  Languages,
  Star,
  UserRoundSearch,
} from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { BookingPanel } from './BookingPanel';

/**
 * One mentor's profile.
 *
 * The counterpart to MentorsList, and it follows the same rules: real data
 * only, explicit loading / empty / error states, and the booking control is
 * chosen from what the SERVER says this viewer may do rather than from a role
 * check written here.
 *
 * The 404 case is deliberately not distinguished from "not approved". An
 * unapproved profile is a set of unverified claims about someone's employer
 * and seniority, and confirming that a given id exists but is hidden is itself
 * information - so both render the same not-found state.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Review = {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  reviewer: { nickname: string; isVerified: boolean } | null;
};

type Mentor = {
  id: string;
  industry: string;
  specialties: string[];
  headline: string;
  about: string;
  company: string | null;
  jobTitle: string | null;
  yearsExperience: number;
  linkedinUrl: string | null;
  languages: string[];
  hourlyRateMinor: number;
  sessionMinutes: number;
  minNoticeHours: number;
  timezone: string;
  isAcceptingBookings: boolean;
  ratingAvg: number;
  ratingCount: number;
  sessionsCompleted: number;
  user: {
    nickname: string;
    avatarUrl: string | null;
    isVerified: boolean;
    headline: string | null;
    bio: string | null;
    university: { code: string; nameEn: string } | null;
  };
  reviews: Review[];
  availabilityRules: { weekday: number; startMinute: number; endMinute: number }[];
};

function initialsOf(nickname: string): string {
  return nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

/** Money is stored in qepik (minor units); never format from a float. */
function formatPrice(minor: number, locale: string): string | null {
  if (minor <= 0) return null;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'AZN' }).format(minor / 100);
}

/** Minutes past midnight -> "09:30". */
function clock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function MentorProfile({ mentorId }: { mentorId: string }) {
  const t = useT();

  const [mentor, setMentor] = useState<Mentor | null>(null);
  const [canBook, setCanBook] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [isSelf, setIsSelf] = useState(false);
  const [viewerReview, setViewerReview] = useState<ViewerReview>({ eligible: false, rating: null, body: null });
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);

  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'az' : 'az';

  const load = useCallback(
    /** `silent` refreshes in place (after a review) instead of flashing the skeleton. */
    async (signal?: AbortSignal, silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const response = await fetch(`/api/mentors/${mentorId}`, { signal });
        if (response.status === 404) {
          setNotFound(true);
          return;
        }
        if (!response.ok) {
          setError('mentors.loadFailed');
          return;
        }
        const data = await response.json();
        setMentor(data.mentor);
        setCanBook(Boolean(data.viewerCanBook));
        setSignedIn(Boolean(data.viewerSignedIn));
        setIsSelf(Boolean(data.viewerIsMentor));
        if (data.viewerReview) setViewerReview(data.viewerReview);
      } catch (cause) {
        if ((cause as Error)?.name === 'AbortError') return;
        setError('mentors.loadFailed');
      } finally {
        setLoading(false);
      }
    },
    [mentorId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6" aria-busy="true">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-muted" />
        <div className="card mt-4 h-48 animate-pulse" />
        <div className="card mt-3 h-64 animate-pulse" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <BackLink />
        <div className="card mt-3 flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-inset">
            <UserRoundSearch className="h-6 w-6 text-fg-subtle" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-lg font-semibold text-fg">{t('mentors.notFound')}</h1>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
            {t('mentors.notFoundHint')}
          </p>
          <Link href="/mentors" className="btn-primary mt-4">
            {t('mentors.browse')}
          </Link>
        </div>
      </div>
    );
  }

  if (error || !mentor) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <BackLink />
        <div className="card mt-3 p-8 text-center">
          <p className="text-sm text-fg-muted">{t(error ?? 'errors.generic')}</p>
          <button type="button" onClick={() => void load()} className="btn-secondary mt-3 px-3 py-1.5 text-sm">
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  const price = formatPrice(mentor.hourlyRateMinor, locale);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <BackLink />

      <header className="card mt-3 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-surface-inset text-lg font-bold text-accent"
            aria-hidden="true"
          >
            {initialsOf(mentor.user.nickname)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="text-xl font-bold tracking-tight text-fg">
                @{mentor.user.nickname}
              </h1>
              {mentor.user.isVerified && (
                <BadgeCheck className="h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
              )}
              {mentor.user.university && (
                <span className="rounded-md bg-surface-inset px-1.5 py-0.5 text-2xs font-semibold text-fg-muted">
                  {mentor.user.university.code}
                </span>
              )}
              <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold text-accent">
                {mentor.industry.replace(/_/g, ' ')}
              </span>
            </div>

            <p className="mt-1.5 text-sm leading-relaxed text-fg">{mentor.headline}</p>

            {(mentor.jobTitle || mentor.company) && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
                <Briefcase className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {[mentor.jobTitle, mentor.company].filter(Boolean).join(' · ')}
                {mentor.yearsExperience > 0 &&
                  ` · ${t('mentors.years', { count: mentor.yearsExperience })}`}
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-muted">
              {mentor.ratingCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Star className="h-3.5 w-3.5 fill-current text-warn" aria-hidden="true" />
                  <span className="tabular font-medium text-fg">{mentor.ratingAvg.toFixed(1)}</span>
                  <span>({mentor.ratingCount})</span>
                </span>
              )}
              <span>{t('mentors.sessions', { count: mentor.sessionsCompleted })}</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {t('mentors.sessionLength', { minutes: mentor.sessionMinutes })}
              </span>
              <span className="font-medium text-fg">
                {price ? t('mentors.rate', { price }) : t('mentors.free')}
              </span>
            </div>
          </div>
        </div>

        {/* Browsing is open; only booking is gated. Saying so here beats
            letting someone read the whole profile and meet a refusal. */}
        {signedIn && !canBook && !isSelf && (
          <p className="mt-4 rounded-lg border border-warn/30 bg-warn-soft p-3 text-sm text-warn-fg">
            {t('mentors.verifiedOnly')}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-edge pt-4">
          {isSelf ? (
            // Your own profile: no point offering to message yourself, and the
            // booking flow would refuse anyway.
            <>
              <Link href="/mentors/apply" className="btn-secondary px-3 py-1.5 text-sm">
                {t('mentors.editProfile')}
              </Link>
              <Link href="/mentors/schedule" className="btn-secondary px-3 py-1.5 text-sm">
                {t('nav.mentorSchedule')}
              </Link>
            </>
          ) : (
            <>
              {canBook && mentor.isAcceptingBookings ? (
                /*
                  Opens the booking panel below rather than linking to
                  /bookings?mentor=<id>, which is a StubPage - so the primary
                  call to action on this whole feature used to land on "not
                  built yet".
                */
                <button
                  type="button"
                  onClick={() => setBooking((v) => !v)}
                  aria-expanded={booking}
                  className="btn-primary px-4 py-1.5 text-sm"
                >
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('mentors.book')}
                </button>
              ) : (
                <button type="button" disabled className="btn-secondary px-4 py-1.5 text-sm">
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                  {mentor.isAcceptingBookings ? t('mentors.book') : t('mentors.notAccepting')}
                </button>
              )}

            </>
          )}

          {mentor.linkedinUrl && (
            <a
              href={mentor.linkedinUrl}
              target="_blank"
              // noreferrer as well as noopener: an outbound profile link should
              // not tell LinkedIn which UniPath page the click came from.
              rel="noopener noreferrer nofollow"
              className="btn-ghost px-3 py-1.5 text-sm"
            >
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              LinkedIn
            </a>
          )}
        </div>
      </header>

      {booking && canBook && mentor.isAcceptingBookings && (
        <BookingPanel
          mentorId={mentor.id}
          sessionMinutes={mentor.sessionMinutes}
          priceMinor={mentor.hourlyRateMinor}
          onClose={() => setBooking(false)}
        />
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-3">
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-fg">{t('mentors.about')}</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
              {mentor.about}
            </p>
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold text-fg">
              {t('mentors.reviews')}{' '}
              {mentor.ratingCount > 0 && (
                <span className="tabular font-normal text-fg-subtle">({mentor.ratingCount})</span>
              )}
            </h2>

            {/* Finished-session mentees get the review box; a signed-in reader
                who has not had a session is told how to earn one. */}
            {!isSelf &&
              (viewerReview.eligible ? (
                <MentorReviewForm
                  mentorId={mentorId}
                  initial={viewerReview}
                  onSaved={() => void load(undefined, true)}
                />
              ) : (
                signedIn && <p className="mt-2 text-xs text-fg-subtle">{t('mentors.reviewForm.afterSession')}</p>
              ))}

            {mentor.reviews.length === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">{t('mentors.noReviews')}</p>
            ) : (
              <ul className="mt-3 space-y-4">
                {mentor.reviews.map((review) => (
                  <li key={review.id} className="border-b border-edge pb-4 last:border-0 last:pb-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-fg">
                        @{review.reviewer?.nickname ?? '—'}
                      </span>
                      {review.reviewer?.isVerified && (
                        <BadgeCheck className="h-3 w-3 text-verified" aria-hidden="true" />
                      )}
                      <span
                        className="ml-auto inline-flex items-center gap-0.5"
                        aria-label={`${review.rating} / 5`}
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <Star
                            key={n}
                            className={`h-3 w-3 ${
                              n <= review.rating ? 'fill-current text-warn' : 'text-fg-subtle'
                            }`}
                            aria-hidden="true"
                          />
                        ))}
                      </span>
                    </div>
                    {review.body && (
                      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
                        {review.body}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-3">
          {mentor.specialties.length > 0 && (
            <section className="card p-4">
              <h2 className="text-sm font-semibold text-fg">{t('mentors.specialties')}</h2>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {mentor.specialties.map((tag) => (
                  <span
                    key={tag}
                    className="badge-accent"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}

          {mentor.languages.length > 0 && (
            <section className="card p-4">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Languages className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
                {t('mentors.languages')}
              </h2>
              <p className="mt-2 text-xs text-fg-muted">
                {mentor.languages.map((l) => l.toUpperCase()).join(' · ')}
              </p>
            </section>
          )}

          <section className="card p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
              <CalendarClock className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
              {t('mentors.availability')}
            </h2>
            {mentor.availabilityRules.length === 0 ? (
              <p className="mt-2 text-xs text-fg-muted">{t('mentors.noAvailability')}</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {mentor.availabilityRules.map((rule, i) => (
                  <li key={i} className="flex justify-between text-xs text-fg-muted">
                    <span>{WEEKDAYS[rule.weekday] ?? '—'}</span>
                    <span className="tabular">
                      {clock(rule.startMinute)}–{clock(rule.endMinute)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2.5 border-t border-edge pt-2 text-2xs text-fg-subtle">
              {mentor.timezone} · {t('mentors.minNotice', { hours: mentor.minNoticeHours })}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link href="/mentors" className="btn-ghost -ml-2 px-2 py-1 text-sm">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      {t('mentors.backToList')}
    </Link>
  );
}
