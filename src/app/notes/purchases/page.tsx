import type { Metadata } from 'next';
import { PurchasesList } from '@/components/notes/PurchasesList';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = {
  title: 'My purchases',
  robots: { index: false, follow: false },
};

/** A purchase history is per-account and must never be cached or prerendered. */
export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * /notes/purchases is in the middleware's PROTECTED and NO_STORE lists, and
 * /api/notes/purchases scopes every row to the caller's own buyerId - the page
 * guard is convenience, the query is the control.
 */
export default async function PurchasesPage() {
  await requirePageSession('/notes/purchases');

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <PurchasesList />
    </main>
  );
}
