import { FieldValue } from 'firebase-admin/firestore';
import { LedgerAccountType, LedgerTxnKind, NoteStatus } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { forFirestore } from '@/lib/firebase/convert';
import { getAccountTx, postTx, sumAccount, accountIdFor } from '@/lib/firebase/repositories/ledger';
import { orderIdFor } from '@/lib/firebase/repositories/notes';
import { scheduleTx } from '@/lib/firebase/repositories/scheduledTasks';

const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? 1500);
const CLEARING_HOURS = Number(process.env.SELLER_CLEARING_HOURS ?? 72);

export class InsufficientFundsError extends Error {
  readonly messageKey = 'notes.errors.insufficientFunds';
}

/**
 * Typed refusals, so the HTTP layer can map an outcome to a status code
 * without string-matching an Error message.
 *
 * These conditions were previously raised as bare `new Error('Cannot buy your
 * own note')`. That works for a caller that only needs the transaction to roll
 * back, but a route has to distinguish "your fault, 400" from "our fault, 500"
 * - and matching on a human-readable string is the kind of coupling that
 * breaks silently the first time somebody rewords the message.
 */
export class NoteNotPurchasableError extends Error {
  readonly messageKey = 'notes.errors.notForSale';
}

export class SelfPurchaseError extends Error {
  readonly messageKey = 'notes.errors.cannotBuyOwn';
}

export class AlreadyPurchasedError extends Error {
  readonly messageKey = 'notes.errors.alreadyOwned';
}

/**
 * Split a price into platform fee and seller net, in minor units.
 * Rounds the fee down so the seller is never short-changed by rounding, and
 * derives the net by subtraction so the two always sum back to the price
 * exactly - which is what the orders_fee_split CHECK constraint enforced.
 */
export function splitPrice(priceMinor: number) {
  const platformFeeMinor = Math.floor((priceMinor * PLATFORM_FEE_BPS) / 10_000);
  return { platformFeeMinor, sellerNetMinor: priceMinor - platformFeeMinor };
}

export type PurchasedOrder = {
  id: string;
  buyerId: string;
  noteId: string;
  priceMinor: number;
  platformFeeMinor: number;
  sellerNetMinor: number;
  currency: string;
  status: 'PAID';
  paidAt: Date;
};

export type PurchasedNote = {
  id: string;
  title: string;
  currency: string;
  seller: { email: string; nickname: string };
};

/**
 * Buy a note.
 *
 * ===========================================================================
 * THE SHAPE OF A FIRESTORE TRANSACTION, AND WHY THIS ONE READS FIRST
 * ===========================================================================
 * Firestore requires every read in a transaction to happen before every write,
 * and it throws if that order is violated. So this function is written in two
 * visibly separate halves: everything it needs to KNOW, then everything it
 * DOES. The old SQL version could interleave freely; this cannot, and the
 * split is deliberate rather than stylistic.
 *
 * The optimistic-concurrency property is what replaces `SELECT ... FOR
 * UPDATE`: if the buyer's wallet document changes between the read and the
 * commit, Firestore aborts and re-runs the whole function. The balance check
 * and the debit that depends on it therefore cannot interleave with a
 * concurrent purchase - which is the only thing the row lock was ever for.
 *
 * ===========================================================================
 * WHAT IS UNCHANGED
 * ===========================================================================
 * Funds land in the seller's PENDING account, not their available balance.
 * They clear after SELLER_CLEARING_HOURS. Without that window the fraud is
 * trivial and we have seen it on every marketplace: upload someone else's
 * copyrighted PDF, buy it from a second account with topped-up funds, withdraw
 * before the takedown lands. The clearing window makes the refund path
 * actually collectible.
 */
export async function purchaseNote(params: {
  buyerId: string;
  noteId: string;
  idempotencyKey: string;
}): Promise<{ order: PurchasedOrder; note: PurchasedNote }> {
  const db = adminDb();

  const noteRef = db.collection(COLLECTIONS.notes).doc(params.noteId);
  const buyerWalletRef = db.collection(COLLECTIONS.wallets).doc(params.buyerId);
  const orderRef = db.collection(COLLECTIONS.orders).doc(orderIdFor(params.buyerId, params.noteId));

  return db.runTransaction(async (tx) => {
    // ---------------------------------------------------------------- reads
    const noteSnap = await tx.get(noteRef);
    if (!noteSnap.exists) throw new NoteNotPurchasableError();
    const note = noteSnap.data() as {
      sellerId: string;
      priceMinor: number;
      currency: string;
      status: string;
      title: string;
    };

    if (note.status !== NoteStatus.PUBLISHED) throw new NoteNotPurchasableError();
    if (note.sellerId === params.buyerId) throw new SelfPurchaseError();

    /**
     * Already owned.
     *
     * The order id is derived from (buyer, note), so this is a keyed read
     * rather than the old `findFirst`. `create()` below is still the real
     * guarantee and still wins any race - this check exists so the common case
     * answers with a clear "you already own this" instead of an ALREADY_EXISTS
     * surfacing as a generic 500.
     */
    const existingOrder = await tx.get(orderRef);
    if (existingOrder.exists) {
      const status = existingOrder.data()?.status;
      if (status === 'PAID' || status === 'PENDING') throw new AlreadyPurchasedError();
    }

    const buyerWalletSnap = await tx.get(buyerWalletRef);
    const buyerWallet = buyerWalletSnap.data() as
      | { availableMinor: number; isFrozen: boolean }
      | undefined;
    if (!buyerWallet || buyerWallet.isFrozen) throw new InsufficientFundsError();
    if (buyerWallet.availableMinor < note.priceMinor) throw new InsufficientFundsError();

    const sellerWalletRef = db.collection(COLLECTIONS.wallets).doc(note.sellerId);
    const sellerWalletSnap = await tx.get(sellerWalletRef);
    if (!sellerWalletSnap.exists) throw new NoteNotPurchasableError();

    // The seller's address, for the "note sold" mail the route sends after the
    // commit. Read here because a transaction cannot read after it writes, and
    // reading it afterwards would be a second round trip on a money path.
    const sellerSnap = await tx.get(db.collection(COLLECTIONS.users).doc(note.sellerId));
    const seller = sellerSnap.data() as { email?: string; nickname?: string } | undefined;

    const currency = note.currency || 'AZN';
    // Account documents are created on first use; resolving them is a read, so
    // it belongs here and not below.
    const buyerAvailable = await getAccountTx(
      tx,
      params.buyerId,
      LedgerAccountType.USER_AVAILABLE,
      currency,
    );
    const sellerPending = await getAccountTx(
      tx,
      note.sellerId,
      LedgerAccountType.USER_PENDING,
      currency,
    );
    const revenue = await getAccountTx(tx, null, LedgerAccountType.PLATFORM_REVENUE, currency);

    // --------------------------------------------------------------- writes
    const { platformFeeMinor, sellerNetMinor } = splitPrice(note.priceMinor);
    const paidAt = new Date();

    for (const account of [buyerAvailable, sellerPending, revenue]) {
      if (!account.existed) {
        tx.set(db.collection(COLLECTIONS.ledgerAccounts).doc(account.id), forFirestore(account.data));
      }
    }

    const order = {
      buyerId: params.buyerId,
      noteId: params.noteId,
      priceMinor: note.priceMinor,
      platformFeeMinor,
      sellerNetMinor,
      currency,
      status: 'PAID' as const,
      idempotencyKey: params.idempotencyKey,
      ledgerTxnId: null as string | null,
      paidAt,
      refundedAt: null,
      createdAt: paidAt,
    };
    // `create`, never `set`: a retried purchase must collide here rather than
    // overwrite a completed order and charge the buyer a second time.
    tx.create(orderRef, forFirestore(order));

    const txnId = postTx(tx, {
      kind: LedgerTxnKind.NOTE_PURCHASE,
      referenceKey: `order:${orderRef.id}`,
      description: `Purchase of note ${params.noteId}`,
      currency,
      legs: [
        {
          accountId: buyerAvailable.id,
          walletId: params.buyerId,
          accountType: LedgerAccountType.USER_AVAILABLE,
          amountMinor: -note.priceMinor,
        },
        {
          accountId: sellerPending.id,
          walletId: note.sellerId,
          accountType: LedgerAccountType.USER_PENDING,
          amountMinor: sellerNetMinor,
        },
        {
          accountId: revenue.id,
          walletId: null,
          accountType: LedgerAccountType.PLATFORM_REVENUE,
          amountMinor: platformFeeMinor,
        },
      ],
      metadata: { noteId: params.noteId, buyerId: params.buyerId },
    });

    tx.update(orderRef, { ledgerTxnId: txnId });

    tx.update(buyerWalletRef, {
      availableMinor: FieldValue.increment(-note.priceMinor),
      version: FieldValue.increment(1),
    });
    tx.update(sellerWalletRef, {
      pendingMinor: FieldValue.increment(sellerNetMinor),
      version: FieldValue.increment(1),
    });
    tx.update(noteRef, { purchaseCount: FieldValue.increment(1) });

    // Clearing is a scheduled task, not a cron scan over all orders.
    scheduleTx(tx, {
      kind: 'ESCROW_RELEASE',
      runAt: new Date(Date.now() + CLEARING_HOURS * 3_600_000),
      dedupeKey: `clear:order:${orderRef.id}`,
      payload: { orderId: orderRef.id, walletId: note.sellerId, amountMinor: sellerNetMinor },
    });

    /**
     * Tell the seller in the same transaction.
     *
     * Written directly rather than through enqueueNotification(). Under the
     * old stack the reason was that enqueueNotification also pushed onto a
     * BullMQ queue, so a Redis outage could roll back a COMPLETED PAYMENT.
     * That queue is gone, but the rule survives it for a better reason: a
     * notification write belongs inside the transaction that earned it, and
     * calling out to a helper that opens its own would put it outside.
     */
    tx.create(
      db.collection(COLLECTIONS.notifications).doc(),
      forFirestore({
        userId: note.sellerId,
        type: 'NOTE_SOLD',
        titleKey: 'notifications.types.NOTE_SOLD',
        bodyKey: 'notifications.noteSold.body',
        params: { title: note.title },
        linkUrl: '/wallet',
        readAt: null,
        createdAt: paidAt,
      }),
    );

    return {
      order: { id: orderRef.id, ...order },
      note: {
        id: params.noteId,
        title: note.title,
        currency,
        seller: { email: seller?.email ?? '', nickname: seller?.nickname ?? '' },
      },
    };
  });
}

/** Moves cleared funds from PENDING to AVAILABLE. Idempotent via referenceKey. */
export async function releasePending(params: {
  referenceKey: string;
  walletId: string;
  amountMinor: number;
  kind: LedgerTxnKind;
  currency?: string;
}): Promise<void> {
  const db = adminDb();
  const currency = params.currency ?? 'AZN';
  const walletRef = db.collection(COLLECTIONS.wallets).doc(params.walletId);

  await db.runTransaction(async (tx) => {
    // Reads first, as always.
    const pending = await getAccountTx(tx, params.walletId, LedgerAccountType.USER_PENDING, currency);
    const available = await getAccountTx(
      tx,
      params.walletId,
      LedgerAccountType.USER_AVAILABLE,
      currency,
    );

    for (const account of [pending, available]) {
      if (!account.existed) {
        tx.set(db.collection(COLLECTIONS.ledgerAccounts).doc(account.id), forFirestore(account.data));
      }
    }

    postTx(tx, {
      kind: params.kind,
      referenceKey: params.referenceKey,
      description: 'Clearing window elapsed',
      currency,
      legs: [
        {
          accountId: pending.id,
          walletId: params.walletId,
          accountType: LedgerAccountType.USER_PENDING,
          amountMinor: -params.amountMinor,
        },
        {
          accountId: available.id,
          walletId: params.walletId,
          accountType: LedgerAccountType.USER_AVAILABLE,
          amountMinor: params.amountMinor,
        },
      ],
    });

    tx.update(walletRef, {
      pendingMinor: FieldValue.increment(-params.amountMinor),
      availableMinor: FieldValue.increment(params.amountMinor),
      version: FieldValue.increment(1),
    });
  });
}

/**
 * Nightly reconciliation. The denormalised wallet fields exist for read
 * performance; the ledger is the truth. Any drift is a bug and must page
 * someone rather than be silently corrected.
 *
 * The SQL version was one GROUP BY over a join. Firestore has neither, so this
 * walks the wallets and sums each one's AVAILABLE account. That is a read per
 * wallet, which is why it is a NIGHTLY job and not something a request path
 * may call - the same shape as the query it replaces, but with the cost moved
 * from the database to the round trips.
 */
export async function reconcile(): Promise<
  { walletId: string; cachedMinor: number; ledgerMinor: number }[]
> {
  const snap = await adminDb().collection(COLLECTIONS.wallets).get();
  const drift: { walletId: string; cachedMinor: number; ledgerMinor: number }[] = [];

  for (const doc of snap.docs) {
    const cachedMinor = Number(doc.data().availableMinor ?? 0);
    const currency = String(doc.data().currency ?? 'AZN');
    const ledgerMinor = await sumAccount(
      accountIdFor(doc.id, LedgerAccountType.USER_AVAILABLE, currency),
    );
    if (cachedMinor !== ledgerMinor) {
      drift.push({ walletId: doc.id, cachedMinor, ledgerMinor });
    }
  }

  return drift;
}
