import type { Metadata } from 'next';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { requirePageSession } from '@/lib/auth/page-guard';
import type { DashboardTab } from '@/components/dashboard/Sidebar';
import type { VerificationState } from '@/components/dashboard/VerificationBanner';

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

// Local on purpose: a value imported from a 'use client' module is a client
// reference in a Server Component, not the array.
const TABS: DashboardTab[] = ['feed', 'notes', 'saved', 'mentors', 'wallet'];
const STATES: VerificationState[] = ['UNVERIFIED', 'PENDING', 'NEEDS_REVIEW', 'REJECTED', 'VERIFIED'];

/** Session state is per-request; this page must never be prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * Dashboard entry point.
 *
 * ---------------------------------------------------------------------------
 * THE SESSION IS NOW READ HERE INSTEAD OF BEING DESCRIBED HERE
 * ---------------------------------------------------------------------------
 * This comment used to say the viewer "comes from the session in production"
 * and show the call that would do it. It was never written, and the middleware
 * was therefore the ONLY thing standing in front of this page - an edge check
 * with no database, which cannot see that a session has been revoked. Signing
 * out and coming back with the same cookie rendered the dashboard in full.
 *
 * requirePageSession() closes that: it reads live account state through
 * requireSession(), so a revoked, expired, idle or banned session lands on
 * /login with its cookies cleared instead of on a signed-in shell.
 *
 * The verification banner now follows the same rule. `?verification=` is still
 * honoured, because the redirect out of registration uses it to land on the
 * right banner, but it can only be read once the session says who is asking,
 * and it is a display choice only - every gated action is checked server-side
 * against `can()` in src/lib/permissions.ts.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; verification?: string }>;
}) {
  const viewer = await requirePageSession('/dashboard');
  const params = await searchParams;

  const tab = TABS.includes(params.tab as DashboardTab) ? (params.tab as DashboardTab) : 'feed';

  /**
   * The live status is the default; the query param may only override it while
   * the two describe the same account's progress through verification. It is
   * what the post-registration redirect uses to show the "we got your
   * documents" banner a beat before the write lands.
   */
  const requested = params.verification?.toUpperCase();
  const verificationState = STATES.includes(requested as VerificationState)
    ? (requested as VerificationState)
    : (viewer.verificationStatus as VerificationState);

  return <DashboardShell initialTab={tab} verificationState={verificationState} />;
}
