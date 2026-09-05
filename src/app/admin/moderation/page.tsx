import type { Metadata } from 'next';
import { ModerationConsole } from '@/components/admin/ModerationConsole';

export const metadata: Metadata = {
  title: 'Moderation',
  robots: { index: false, follow: false },
};

/**
 * Admin moderation panel.
 *
 * Route protection is layered, deliberately:
 *   1. middleware.ts keeps unauthenticated traffic out of /admin entirely;
 *   2. every /api/admin/* handler re-checks the role against LIVE database
 *      state, because the JWT role claim can be up to 15 minutes stale and a
 *      demoted moderator must lose access immediately.
 *
 * The page itself renders no sensitive data on the server - the console fetches
 * per-case, and each fetch writes an audit row. That way "who looked at whose
 * ID, and when" is answerable from the audit log alone.
 */
export default function ModerationPage() {
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <ModerationConsole />
    </main>
  );
}
