import type { Metadata } from 'next';
import { ProfileView } from '@/components/profile/ProfileView';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = {
  title: 'Profile',
  robots: { index: false, follow: false },
};

/** Session state is per-request; this page must never be prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * The account menu in the sidebar was never broken - it has a trigger, open
 * state, outside-click handling and real <Link>s. It just pointed here, and
 * here was a "not built yet" placeholder, so the click looked like a no-op.
 */
export default async function ProfilePage() {
  await requirePageSession('/profile');

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <ProfileView />
    </main>
  );
}
