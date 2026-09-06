import type { Metadata } from 'next';
import { NotificationsView } from '@/components/notifications/NotificationsView';

export const metadata: Metadata = {
  title: 'Notifications',
  robots: { index: false, follow: false },
};

/** Nothing on this page may be cached: it lists one account's own events. */
export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * The route is in the middleware's PROTECTED list, so an anonymous visitor is
 * redirected to /login before this renders, and /api/notifications re-checks
 * the session independently - the page guard is convenience, not the control.
 */
export default function NotificationsPage() {
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <NotificationsView />
    </main>
  );
}
