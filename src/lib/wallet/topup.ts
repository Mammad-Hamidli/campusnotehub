import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { LedgerAccountType, LedgerTxnKind } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { forFirestore } from '@/lib/firebase/convert';
import { getAccountTx, postTx, txnIdFor } from '@/lib/firebase/repositories/ledger';

/** 1 AZN .. 500 AZN per top-up, in qepik. */
export const MIN_TOPUP_MINOR = 100;
export const MAX_TOPUP_MINOR = 50_000;

export class WalletFrozenError extends Error {}
export class WalletMissingError extends Error {}
export class PaymentDeclinedError extends Error {}

/**
 * The payment step.
 *
 * PLACEHOLDER. No card processor is integrated yet, so `stub` captures every
 * request immediately. This is the one function a real gateway replaces: it
 * must charge the payer and return the provider's reference, or throw
 * PaymentDeclinedError. Everything downstream - the double-entry ledger post,
 * the balance, the history, the email - is already the real thing.
 */
async function capturePayment(params: {
  userId: string;
  amountMinor: number;
}): Promise<{ provider: string; providerRef: string }> {
  const configured = (process.env.PAYMENT_PROVIDER || 'stub').toLowerCase();
  // No real gateway is integrated yet, so every top-up goes through the stub.
  // In PRODUCTION that is only allowed when explicitly opted into with
  // PAYMENT_PROVIDER=stub: a production deploy naming a provider that is not
  // implemented must refuse rather than credit money nobody paid.
  if (configured !== 'stub' && process.env.NODE_ENV === 'production') {
    throw new PaymentDeclinedError(`payment provider "${configured}" is not implemented`);
  }
  void params;
  return { provider: 'stub', providerRef: `stub_${randomUUID()}` };
}

/**
 * Adds funds to a wallet.
 *
 * Double-entry, like every money movement here: EXTERNAL_GATEWAY is debited
 * and the user's USER_AVAILABLE account credited by the same amount, in one
 * Firestore transaction with the wallet balance update. The transaction id is
 * derived from (user, idempotencyKey), so a retried request - a double click,
 * a network retry - replays to the same result instead of crediting twice.
 */
export async function topUpWallet(params: {
  userId: string;
  amountMinor: number;
  idempotencyKey: string;
}): Promise<{ txnId: string; availableMinor: number; replayed: boolean }> {
  const db = adminDb();
  const walletRef = db.collection(COLLECTIONS.wallets).doc(params.userId);
  const referenceKey = `topup:${params.userId}:${params.idempotencyKey}`;
  const txnRef = db.collection(COLLECTIONS.ledgerTransactions).doc(txnIdFor(referenceKey));

  // Replay check before charging: an idempotent retry must not charge again.
  const [existingTxn, walletBefore] = await Promise.all([txnRef.get(), walletRef.get()]);
  if (!walletBefore.exists) throw new WalletMissingError();
  if (existingTxn.exists) {
    return {
      txnId: txnRef.id,
      availableMinor: (walletBefore.data()?.availableMinor as number) ?? 0,
      replayed: true,
    };
  }
  if (walletBefore.data()?.isFrozen) throw new WalletFrozenError();

  const payment = await capturePayment({ userId: params.userId, amountMinor: params.amountMinor });

  return db.runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.data() as
      | { availableMinor: number; isFrozen: boolean; currency?: string }
      | undefined;
    if (!wallet) throw new WalletMissingError();
    if (wallet.isFrozen) throw new WalletFrozenError();

    const currency = wallet.currency || 'AZN';
    const userAvailable = await getAccountTx(
      tx,
      params.userId,
      LedgerAccountType.USER_AVAILABLE,
      currency,
    );
    const gateway = await getAccountTx(tx, null, LedgerAccountType.EXTERNAL_GATEWAY, currency);

    for (const account of [userAvailable, gateway]) {
      if (!account.existed) {
        tx.set(db.collection(COLLECTIONS.ledgerAccounts).doc(account.id), forFirestore(account.data));
      }
    }

    const txnId = postTx(tx, {
      kind: LedgerTxnKind.TOPUP,
      referenceKey,
      description: 'Balance top-up',
      currency,
      metadata: { provider: payment.provider, providerRef: payment.providerRef },
      legs: [
        {
          accountId: gateway.id,
          walletId: null,
          accountType: LedgerAccountType.EXTERNAL_GATEWAY,
          amountMinor: -params.amountMinor,
        },
        {
          accountId: userAvailable.id,
          walletId: params.userId,
          accountType: LedgerAccountType.USER_AVAILABLE,
          amountMinor: params.amountMinor,
        },
      ],
    });

    tx.update(walletRef, {
      availableMinor: FieldValue.increment(params.amountMinor),
      version: FieldValue.increment(1),
      updatedAt: new Date(),
    });

    return {
      txnId,
      availableMinor: (wallet.availableMinor ?? 0) + params.amountMinor,
      replayed: false,
    };
  });
}
