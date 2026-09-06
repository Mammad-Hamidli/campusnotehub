import type { Metadata } from 'next';
import { ProfileView } from '@/components/profile/ProfileView';

export const metadata: Metadata = {
  title: 'Profile',
  robots: { index: false, follow: false },
};

/**
 * Replaces the previous StubPage.
 *
 * The account menu in the sidebar was never broken - it has a trigger, open
 * state, outside-click handling and real <Link>s. It just pointed here, and
 * here was a "not built yet" placeholder, so the click looked like a no-op.
 */
export default function ProfilePage() {
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <ProfileView />
    </main>
  );
}
