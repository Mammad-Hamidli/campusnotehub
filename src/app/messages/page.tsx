import type { Metadata } from 'next';
import { MessagesView } from '@/components/messages/MessagesView';

export const metadata: Metadata = {
  title: 'Messages',
  robots: { index: false, follow: false },
};

/** Private correspondence: never statically rendered, never cached. */
export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * /messages is in the middleware's PROTECTED and NO_STORE lists, so an
 * anonymous visitor is redirected and a signed-out back-button press cannot
 * re-display someone's inbox from the browser cache. Every /api/messages
 * handler re-checks membership independently - this page guard is convenience,
 * not the control.
 */
export default function MessagesPage() {
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <MessagesView />
    </main>
  );
}
