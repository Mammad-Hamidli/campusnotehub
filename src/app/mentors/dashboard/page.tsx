import type { Metadata } from 'next';
import Link from 'next/link';
import { BackLink } from '@/components/ui/BackLink';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ArrowUpRight, CalendarClock, FileText, MessagesSquare, type LucideIcon } from 'lucide-react';
import { requirePageSession } from '@/lib/auth/page-guard';
import { can } from '@/lib/permissions';
import { findUserById } from '@/lib/firebase/repositories/users';
import { findMentorApplication } from '@/lib/firebase/repositories/mentorApplications';
import { findMentorByUserId, listUpcomingMentorBookings } from '@/lib/firebase/repositories/mentors';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findCalendarLink } from '@/lib/firebase/repositories/calendarLinks';
import { answerDeadline, isPendingRequest } from '@/lib/mentors/requests';
import { billingSnapshot } from '@/lib/mentors/billing';
import { buildMentorChecklist } from '@/lib/mentors/checklist';
import { mentorJoinDate } from '@/lib/mentors/membership';
import { DEFAULT_LOCALE, DICTIONARIES, LOCALE_COOKIE, isLocale, translate } from '@/lib/i18n/dictionaries';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';
import { OnboardingChecklist } from '@/components/mentors/dashboard/OnboardingChecklist';
import { PaymentReminderCard } from '@/components/mentors/dashboard/PaymentReminderCard';
import { MentorStats } from '@/components/mentors/dashboard/MentorStats';
import { UpcomingSessions } from '@/components/mentors/dashboard/UpcomingSessions';
import { SessionRequestsCard } from '@/components/mentors/dashboard/SessionRequestsCard';
import { GoogleCalendarCard } from '@/components/mentors/dashboard/GoogleCalendarCard';
import type { Translate } from '@/components/mentors/dashboard/format';

export const metadata: Metadata = { title: 'Mentor panel', robots: { index: false, follow: false } };

/** How many of the upcoming sessions the list shows; the stat counts all. */
const UPCOMING_SHOWN = 5;

/** Session state and live data per request; never prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * The mentor panel.
 *
 * ---------------------------------------------------------------------------
 * WHO GETS IT
 * ---------------------------------------------------------------------------
 * can(viewer, 'mentors:console'): a MENTOR account, or an ALUMNI/TEACHER one
 * with `mentorSince` (src/lib/mentors/membership.ts). Anyone else is sent to
 * the ordinary dashboard - not a 403, because a student who followed an old
 * link has simply come to the wrong room. The middleware only guarantees a
 * signed-in cookie; this check reads the live account.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SHOWS
 * ---------------------------------------------------------------------------
 * The onboarding checklist until the mentor is bookable, the monthly fee
 * reminder, and - once approved - the profile's numbers and next sessions.
 * Everything is the viewer's OWN data, read with keyed lookups plus one
 * equality query for bookings, so no composite index is involved.
 *
 * Rendered entirely on the server, widgets included: see
 * src/components/mentors/dashboard/format.ts for the az date-format reason.
 */
export default async function MentorDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ calendar?: string; oauth?: string }>;
}) {
  const viewer = await requirePageSession(MENTOR_DASHBOARD_PATH);
  if (!can(viewer, 'mentors:console')) redirect('/dashboard');

  const [user, application, profile, calendarLink, query] = await Promise.all([
    findUserById(viewer.id),
    findMentorApplication(viewer.id),
    findMentorByUserId(viewer.id),
    findCalendarLink(viewer.id),
    searchParams,
  ]);
  // The session was valid a moment ago; a vanished row is a deleted account.
  if (!user) redirect('/logout');

  const now = new Date();
  const live = profile?.isApproved === true;
  const active = live ? await listUpcomingMentorBookings(profile.id, now) : [];
  // One read serves both lists: requests still waiting for an answer, and
  // sessions that are actually on.
  const pending = active.filter((b) => isPendingRequest(b, now));
  const upcoming = active.filter((b) => b.status !== 'REQUESTED');
  const mentees = await findUsersByIds(pending.map((b) => b.menteeId));
  const requests = pending.flatMap((b) => {
    const mentee = mentees.get(b.menteeId);
    if (!mentee || mentee.deletedAt) return [];
    return [
      {
        id: b.id,
        startsAt: b.startsAt,
        answerBy: answerDeadline(b),
        topic: b.topic,
        menteeNote: b.menteeNote,
        mentee: mentee.nickname,
      },
    ];
  });

  /**
   * The fee schedule is computed in the platform's time zone (billingSnapshot
   * defaults to Asia/Baku), not the mentor's: the date a payment is due must
   * be the same for the mentor and for whoever receives it. Session times,
   * below, use the mentor's own zone.
   */
  const joinedAt = mentorJoinDate(user);
  const billing = joinedAt ? billingSnapshot(joinedAt, now) : null;

  const steps = buildMentorChecklist({
    emailVerified: user.emailVerifiedAt != null,
    verificationStatus: user.verificationStatus,
    application: application
      ? { status: application.status, rejectionReason: application.rejectionReason }
      : null,
    profile: profile ? { isApproved: profile.isApproved, isAcceptingBookings: profile.isAcceptingBookings } : null,
  });
  const onboarding = steps.some((step) => step.state !== 'done');

  const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const dict = DICTIONARIES[locale];
  const t: Translate = (key, params) => translate(dict, key, params);

  const links: { href: string; icon: LucideIcon; labelKey: string }[] = [
    ...(live ? [{ href: '/mentors/schedule', icon: CalendarClock, labelKey: 'mentorDashboard.links.schedule' }] : []),
    { href: '/mentors/apply', icon: FileText, labelKey: 'mentorDashboard.links.application' },
    { href: '/dashboard', icon: MessagesSquare, labelKey: 'mentorDashboard.links.feed' },
  ];

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        <BackLink fallbackHref="/dashboard" />

        <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-fg">{t('mentorDashboard.title')}</h1>
            <p className="mt-1 text-sm text-fg-muted">
              {t('mentorDashboard.subtitle', { nickname: user.nickname })}
            </p>
          </div>
          {live && (
            <Link href={`/mentors/${profile.id}`} className="btn-secondary px-3.5 py-2 text-sm">
              {t('mentorDashboard.viewProfile')}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}
        </header>

        {onboarding && (
          <div className="mt-6">
            <OnboardingChecklist steps={steps} t={t} />
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* First in the DOM so the fee reminder sits high on a phone;
              moved to the right-hand column from lg up. */}
          <aside className="space-y-5 lg:order-last">
            {billing && <PaymentReminderCard billing={billing} locale={locale} t={t} />}

            <GoogleCalendarCard
              link={calendarLink ? { status: calendarLink.status, accountHint: calendarLink.accountHint } : null}
              notice={query.calendar === 'connected' ? 'connected' : (query.oauth ?? null)}
              t={t}
            />

            <nav aria-label={t('mentorDashboard.links.title')} className="card p-2">
              {links.map(({ href, icon: Icon, labelKey }) => (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{t(labelKey)}</span>
                </Link>
              ))}
            </nav>
          </aside>

          <div className="min-w-0 space-y-5 lg:col-span-2">
            {live && (
              <SessionRequestsCard
                requests={requests}
                calendarConnected={calendarLink?.status === 'ACTIVE'}
                locale={locale}
                timeZone={profile?.timezone ?? user.timezone ?? 'Asia/Baku'}
                t={t}
              />
            )}
            {live && (
              <MentorStats
                sessionsCompleted={profile.sessionsCompleted}
                ratingAvg={profile.ratingAvg}
                ratingCount={profile.ratingCount}
                upcoming={upcoming.length}
                t={t}
              />
            )}
            <UpcomingSessions
              sessions={upcoming
                .slice(0, UPCOMING_SHOWN)
                .map((b) => ({ id: b.id, startsAt: b.startsAt, topic: b.topic, status: b.status }))}
              live={live}
              locale={locale}
              timeZone={profile?.timezone ?? user.timezone ?? 'Asia/Baku'}
              t={t}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
