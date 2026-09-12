import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, forFirestore } from '../convert';

/**
 * Wallet documents.
 *
 * ---------------------------------------------------------------------------
 * SCOPE: THIS FILE DOES NOT MOVE MONEY
 * ---------------------------------------------------------------------------
 * It creates and reads the wallet row, nothing more. Every balance change goes
 * through the double-entry ledger, which is a separate and much more careful
 * piece of work: Firestore has no `SELECT ... FOR UPDATE`, no deferred
 * constraint triggers and no way to assert "debits equal credits" at commit
 * time, so the accounting cannot be a line-by-line translation of the SQL.
 * Keeping wallet creation here means registration does not have to wait on
 * that.
 *
 * THE DOCUMENT ID IS THE USER ID. Under Postgres `userId` carried a UNIQUE
 * constraint, giving one wallet per user. Firestore has no unique index, so
 * the constraint is expressed structurally instead - keying the document by
 * the owner makes a second wallet unrepresentable rather than merely
 * forbidden. It also turns "fetch my wallet" into a keyed read.
 *
 * Balances are integer MINOR units (qəpik). No floats touch money.
 */

export type WalletRecord = {
  id: string;
  userId: string;
  currency: string;
  availableMinor: number;
  pendingMinor: number;
  version: number;
  isFrozen: boolean;
  createdAt: Date;
};

const wallets = () => adminDb().collection(COLLECTIONS.wallets);

export async function findWalletByUserId(userId: string): Promise<WalletRecord | null> {
  return docToObject<WalletRecord>(await wallets().doc(userId).get()) as WalletRecord | null;
}

/**
 * Creates the wallet if it is not already there.
 *
 * IDEMPOTENT ON PURPOSE. Registration calls this, and a retried registration
 * must not overwrite a wallet that already holds a balance - that would be
 * silent destruction of money. `create()` throws ALREADY_EXISTS rather than
 * merging, and that outcome is treated as success because the postcondition
 * ("this user has a wallet") is satisfied either way.
 */
export async function ensureWallet(userId: string, currency = 'AZN'): Promise<void> {
  try {
    await wallets()
      .doc(userId)
      .create(
        forFirestore({
          userId,
          currency,
          availableMinor: 0,
          pendingMinor: 0,
          version: 0,
          isFrozen: false,
          createdAt: new Date(),
        }),
      );
  } catch (error) {
    // 6 = ALREADY_EXISTS. Anything else is a real failure and must surface.
    if ((error as { code?: number }).code !== 6) throw error;
  }
}
