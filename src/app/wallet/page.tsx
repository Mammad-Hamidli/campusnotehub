import type { Metadata } from 'next';
import { WalletView } from '@/components/wallet/WalletView';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = {
  title: 'Wallet',
  robots: { index: false, follow: false },
};

/** A balance is per-account and must never be cached or prerendered. */
export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * /wallet is already in the middleware's PROTECTED and NO_STORE lists, and
 * /api/wallet scopes every row to the caller's own wallet - the page guard is
 * convenience, the query is the control.
 */
export default async function WalletPage() {
  await requirePageSession('/wallet');

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <WalletView />
    </main>
  );
}
