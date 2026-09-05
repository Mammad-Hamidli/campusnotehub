import type { Metadata } from 'next';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import type { DashboardTab } from '@/components/dashboard/Sidebar';
import type { VerificationState } from '@/components/dashboard/VerificationBanner';

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

const TABS: DashboardTab[] = ['feed', 'notes', 'mentors', 'wallet'];
const STATES: VerificationState[] = ['UNVERIFIED', 'PENDING', 'NEEDS_REVIEW', 'REJECTED', 'VERIFIED'];

/**
 * Dashboard entry point.
 *
 * `?verification=` is read from the URL only so the state is demoable and so
 * the redirect out of registration lands on the right banner. In production
 * this comes from the session:
 *
 *   const { viewer } = await requireSession();
 *   <DashboardShell verificationState={viewer.verificationStatus} ... />
 *
 * requireSession() (src/lib/auth/session.ts) reads live account state on every
 * request rather than trusting the JWT claim, so a ban issued two minutes ago
 * takes effect immediately instead of waiting out the 15-minute token TTL.
 * A query param must never be load-bearing for a permission decision — here it
 * only picks which banner to render, and every gated action is checked
 * server-side against `can()` in src/lib/permissions.ts.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; verification?: string }>;
}) {
  const params = await searchParams;

  const tab = TABS.includes(params.tab as DashboardTab) ? (params.tab as DashboardTab) : 'feed';

  const verification = params.verification?.toUpperCase();
  const verificationState = STATES.includes(verification as VerificationState)
    ? (verification as VerificationState)
    : 'PENDING';

  return <DashboardShell initialTab={tab} verificationState={verificationState} />;
}
