import { LedgerAccountType, LedgerTxnKind, type Prisma, type PrismaClient } from '@prisma/client';

const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? 1500);
const CLEARING_HOURS = Number(process.env.SELLER_CLEARING_HOURS ?? 72);

export class InsufficientFundsError extends Error {
  readonly messageKey = 'notes.errors.insufficientFunds';
}

/**
 * Split a price into platform fee and seller net, in minor units.
 * Rounds the fee down so the seller is never short-changed by rounding, and
 * derives the net by subtraction so the two always sum back to the price
 * exactly - which is what the orders_fee_split CHECK constraint enforces.
 */
export function splitPrice(priceMinor: number) {
  const platformFeeMinor = Math.floor((priceMinor * PLATFORM_FEE_BPS) / 10_000);
  return { platformFeeMinor, sellerNetMinor: priceMinor - platformFeeMinor };
}

type Leg = { accountId: string; amountMinor: number };

/**
 * The only way money moves.
 *
 * Every transfer is a set of signed legs summing to zero, posted inside the
 * caller's transaction. A deferred constraint trigger rejects the whole
 * transaction if the legs do not balance, so an incomplete transfer cannot be
 * committed even if this function has a bug. `referenceKey` is unique, which
 * makes every posting exactly-once: a retried purchase request hits the unique
 * violation instead of charging the buyer twice.
 */
export async function post(
  tx: Prisma.TransactionClient,
  params: {
    kind: LedgerTxnKind;
    referenceKey: string;
    description: string;
    legs: Leg[];
    metadata?: Prisma.InputJsonValue;
  },
) {
  const sum = params.legs.reduce((s, l) => s + l.amountMinor, 0);
  if (sum !== 0) throw new Error(`Unbalanced posting: ${sum}`);

  return tx.ledgerTransaction.create({
    data: {
      kind: params.kind,
      referenceKey: params.referenceKey,
      description: params.description,
      metadata: params.metadata,
      entries: { createMany: { data: params.legs } },
    },
  });
}

export async function getAccount(
  tx: Prisma.TransactionClient,
  walletId: string | null,
  type: LedgerAccountType,
) {
  const existing = await tx.ledgerAccount.findFirst({ where: { walletId, type } });
  if (existing) return existing;
  return tx.ledgerAccount.create({ data: { walletId, type } });
}

/**
 * Buy a note.
 *
 * Funds land in the seller's PENDING account, not their available balance.
 * They clear after SELLER_CLEARING_HOURS. Without that window, the fraud is
 * trivial and we have seen it on every marketplace: upload someone else's
 * copyrighted PDF, buy it from a second account with topped-up funds, withdraw
 * before the takedown lands. The clearing window makes the refund path
 * actually collectible.
 */
export async function purchaseNote(
  db: PrismaClient,
  params: { buyerId: string; noteId: string; idempotencyKey: string },
) {
  return db.$transaction(
    async (tx) => {
      const note = await tx.note.findUniqueOrThrow({
        where: { id: params.noteId },
        select: { id: true, sellerId: true, priceMinor: true, status: true, title: true },
      });
      if (note.status !== 'PUBLISHED') throw new Error('Note is not for sale');
      if (note.sellerId === params.buyerId) throw new Error('Cannot buy your own note');

      // Lock the buyer wallet row for the balance check + debit.
      const [buyerWallet] = await tx.$queryRaw<{ id: string; availableMinor: number; isFrozen: boolean }[]>`
        SELECT id, "availableMinor", "isFrozen" FROM wallets
        WHERE "userId" = ${params.buyerId} FOR UPDATE
      `;
      if (!buyerWallet || buyerWallet.isFrozen) throw new InsufficientFundsError();
      if (buyerWallet.availableMinor < note.priceMinor) throw new InsufficientFundsError();

      const sellerWallet = await tx.wallet.findUniqueOrThrow({ where: { userId: note.sellerId } });
      const { platformFeeMinor, sellerNetMinor } = splitPrice(note.priceMinor);

      const order = await tx.order.create({
        data: {
          buyerId: params.buyerId,
          noteId: note.id,
          priceMinor: note.priceMinor,
          platformFeeMinor,
          sellerNetMinor,
          status: 'PAID',
          paidAt: new Date(),
          idempotencyKey: params.idempotencyKey,
        },
      });

      const buyerAvailable = await getAccount(tx, buyerWallet.id, 'USER_AVAILABLE');
      const sellerPending = await getAccount(tx, sellerWallet.id, 'USER_PENDING');
      const revenue = await getAccount(tx, null, 'PLATFORM_REVENUE');

      const txn = await post(tx, {
        kind: LedgerTxnKind.NOTE_PURCHASE,
        referenceKey: `order:${order.id}`,
        description: `Purchase of note ${note.id}`,
        legs: [
          { accountId: buyerAvailable.id, amountMinor: -note.priceMinor },
          { accountId: sellerPending.id, amountMinor: sellerNetMinor },
          { accountId: revenue.id, amountMinor: platformFeeMinor },
        ],
        metadata: { noteId: note.id, buyerId: params.buyerId },
      });

      await tx.wallet.update({
        where: { id: buyerWallet.id },
        data: { availableMinor: { decrement: note.priceMinor }, version: { increment: 1 } },
      });
      await tx.wallet.update({
        where: { id: sellerWallet.id },
        data: { pendingMinor: { increment: sellerNetMinor }, version: { increment: 1 } },
      });
      await tx.order.update({ where: { id: order.id }, data: { ledgerTxnId: txn.id } });
      await tx.note.update({
        where: { id: note.id },
        data: { purchaseCount: { increment: 1 } },
      });

      // Clearing is a scheduled task, not a cron scan over all orders.
      await tx.scheduledTask.create({
        data: {
          kind: 'ESCROW_RELEASE',
          runAt: new Date(Date.now() + CLEARING_HOURS * 3_600_000),
          dedupeKey: `clear:order:${order.id}`,
          payload: { orderId: order.id, walletId: sellerWallet.id, amountMinor: sellerNetMinor },
        },
      });

      return order;
    },
    { isolationLevel: 'ReadCommitted', timeout: 10_000 },
  );
}

/** Moves cleared funds from PENDING to AVAILABLE. Idempotent via referenceKey. */
export async function releasePending(
  db: PrismaClient,
  params: { referenceKey: string; walletId: string; amountMinor: number; kind: LedgerTxnKind },
) {
  return db.$transaction(async (tx) => {
    const pending = await getAccount(tx, params.walletId, 'USER_PENDING');
    const available = await getAccount(tx, params.walletId, 'USER_AVAILABLE');
    await post(tx, {
      kind: params.kind,
      referenceKey: params.referenceKey,
      description: 'Clearing window elapsed',
      legs: [
        { accountId: pending.id, amountMinor: -params.amountMinor },
        { accountId: available.id, amountMinor: params.amountMinor },
      ],
    });
    await tx.wallet.update({
      where: { id: params.walletId },
      data: {
        pendingMinor: { decrement: params.amountMinor },
        availableMinor: { increment: params.amountMinor },
        version: { increment: 1 },
      },
    });
  });
}

/**
 * Nightly reconciliation. The denormalised wallet columns exist for read
 * performance; the ledger is the truth. Any drift is a bug and must page
 * someone rather than be silently corrected.
 */
export async function reconcile(db: PrismaClient) {
  return db.$queryRaw<
    { walletId: string; cachedMinor: number; ledgerMinor: number }[]
  >`
    SELECT w.id AS "walletId",
           w."availableMinor" AS "cachedMinor",
           COALESCE(SUM(e."amountMinor"), 0)::int AS "ledgerMinor"
    FROM wallets w
    LEFT JOIN ledger_accounts a ON a."walletId" = w.id AND a.type = 'USER_AVAILABLE'
    LEFT JOIN ledger_entries e ON e."accountId" = a.id
    GROUP BY w.id, w."availableMinor"
    HAVING w."availableMinor" <> COALESCE(SUM(e."amountMinor"), 0)::int
  `;
}
