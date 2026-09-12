import { NextResponse, type NextRequest } from 'next/server';
import { findWalletByUserId } from '@/lib/firebase/repositories/wallets';
import { listWalletEntries } from '@/lib/firebase/repositories/ledger';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/wallet - the viewer's own balance and recent ledger activity.
 *
 * ---------------------------------------------------------------------------
 * BALANCES COME FROM THE WALLET ROW, HISTORY FROM THE LEDGER
 * ---------------------------------------------------------------------------
 * That split is deliberate and matches the note on reconcile() in
 * src/lib/wallet/ledger.ts: the denormalised `availableMinor` / `pendingMinor`
 * columns exist so a balance is one indexed read rather than a SUM over every
 * entry ever posted, while the ledger remains the truth. This endpoint does
 * not attempt to reconcile the two - drift is a bug that must page someone,
 * not something a read endpoint quietly papers over.
 *
 * `pendingMinor` is money that is real but not yet spendable: a seller's
 * earnings sit there for SELLER_CLEARING_HOURS so a refund is still
 * collectible. Showing it separately is the honest presentation - folding it
 * into one number would tell a seller they can withdraw funds they cannot.
 */
export async function GET(request: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const wallet = await findWalletByUserId(userId);

  if (!wallet) {
    // Every account gets a wallet at registration, so this means the row was
    // never created - an empty wallet is the correct, non-alarming rendering.
    return NextResponse.json(
      { wallet: { currency: 'AZN', availableMinor: 0, pendingMinor: 0, isFrozen: false }, entries: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  /**
   * Recent activity, read through the ledger ENTRIES that touch this wallet's
   * accounts. Scoped by walletId in the query - a ledger is the one place
   * where returning a row that belongs to someone else discloses their income.
   */
  const entries = await listWalletEntries(wallet.id, 50);

  return NextResponse.json(
    {
      wallet: {
        id: wallet.id,
        currency: wallet.currency,
        availableMinor: wallet.availableMinor,
        pendingMinor: wallet.pendingMinor,
        isFrozen: wallet.isFrozen,
      },
      /**
       * The account type, kind and description come off the ENTRY itself.
       *
       * Under SQL these arrived through two joins. Firestore cannot join, so
       * an entry carries a copy of them, written once at posting time and
       * never updated - see the header of the ledger repository for why that
       * denormalisation is safe on an append-only collection.
       */
      entries: entries.map((e) => ({
        id: e.id,
        amountMinor: e.amountMinor,
        currency: e.currency,
        // USER_AVAILABLE vs USER_PENDING is what tells a seller whether a line
        // is spendable money or still clearing.
        accountType: e.accountType,
        kind: e.kind,
        description: e.description,
        createdAt: e.createdAt.toISOString(),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
