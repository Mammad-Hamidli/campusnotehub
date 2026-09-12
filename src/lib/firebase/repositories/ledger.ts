import type { Transaction } from 'firebase-admin/firestore';
import type { LedgerAccountType, LedgerTxnKind } from '@/lib/enums';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docsToObjects, forFirestore, sortBy } from '../convert';

/**
 * The double-entry ledger, on Firestore.
 *
 * ===========================================================================
 * WHAT POSTGRES ENFORCED, AND WHERE EACH GUARANTEE WENT
 * ===========================================================================
 * The SQL ledger leaned on four database features. Firestore has none of them,
 * so each one had to be re-established somewhere else rather than quietly
 * dropped. Enumerated, because a ledger that loses one of these is a ledger
 * that loses money:
 *
 *  1. DEFERRED CONSTRAINT TRIGGER: "debits equal credits at commit time".
 *     -> Now an assertion in post(), evaluated BEFORE any write in the
 *        transaction. Weaker in one specific way and it is worth being precise
 *        about which: the SQL trigger caught an unbalanced posting even if the
 *        application had a bug, whereas this catches it only if the legs
 *        passed in are wrong. Since post() is the only writer of entries and
 *        it always writes the legs it checked, the gap is closed by making
 *        this function the sole path - which it already was.
 *
 *  2. `SELECT ... FOR UPDATE` on the buyer's wallet.
 *     -> A Firestore transaction. It is optimistic rather than pessimistic:
 *        instead of blocking writers, it aborts and RETRIES if a document read
 *        inside it changed before commit. The end state is the same - a
 *        balance check and the debit that depends on it cannot interleave with
 *        another purchase - which is the only property the row lock was there
 *        for.
 *
 *  3. UNIQUE (referenceKey) on ledger_transactions: postings are exactly-once.
 *     -> The document id IS the reference key. A repeated posting is not a
 *        duplicate row for a constraint to reject; it is the same id, and
 *        `create()` fails with ALREADY_EXISTS. See txnIdFor().
 *
 *  4. UNIQUE (walletId, type, currency) on ledger_accounts.
 *     -> Same technique: the account id is derived from that exact tuple, so
 *        a wallet cannot acquire two AVAILABLE accounts.
 *
 * ===========================================================================
 * ENTRIES CARRY A COPY OF WHAT THE JOIN USED TO SUPPLY
 * ===========================================================================
 * `GET /api/wallet` read entries by joining through ledger_accounts to filter
 * on walletId, and through ledger_transactions for the kind and description.
 * Firestore cannot join, and fetching every account first to build an `in`
 * filter would be a read per account on a hot path.
 *
 * So an entry denormalises `walletId`, `accountType`, `kind` and `description`
 * at write time. This is safe precisely BECAUSE the ledger is append-only:
 * denormalisation goes wrong when the copied value later changes, and no field
 * copied here is ever updated. A posted entry is immutable by policy, and now
 * also by the security rules, which deny update and delete on these
 * collections outright.
 *
 * Amounts are signed integer MINOR units. No floats touch money.
 */

export type LedgerEntryRecord = {
  id: string;
  transactionId: string;
  accountId: string;
  walletId: string | null;
  accountType: LedgerAccountType;
  amountMinor: number;
  currency: string;
  kind: LedgerTxnKind;
  description: string;
  createdAt: Date;
};

export type Leg = { accountId: string; amountMinor: number };

const accounts = () => adminDb().collection(COLLECTIONS.ledgerAccounts);
const transactions = () => adminDb().collection(COLLECTIONS.ledgerTransactions);
const entries = () => adminDb().collection(COLLECTIONS.ledgerEntries);

/** Firestore forbids `/` in a document id; reference keys contain `:`, not `/`. */
function safeId(raw: string): string {
  return raw.replace(/\//g, '_');
}

/** The derived transaction id - this is what makes a posting exactly-once. */
export function txnIdFor(referenceKey: string): string {
  return safeId(referenceKey);
}

/** The derived account id - this is what makes the account tuple unique. */
export function accountIdFor(
  walletId: string | null,
  type: LedgerAccountType,
  currency = 'AZN',
): string {
  return safeId(`${walletId ?? 'platform'}__${type}__${currency}`);
}

export type LedgerAccountRecord = {
  id: string;
  walletId: string | null;
  type: LedgerAccountType;
  currency: string;
  createdAt: Date;
};

/**
 * Resolves an account inside a transaction, creating it on first use.
 *
 * ---------------------------------------------------------------------------
 * WHY THE READ IS PASSED IN RATHER THAN DONE HERE INDEPENDENTLY
 * ---------------------------------------------------------------------------
 * A Firestore transaction requires EVERY read to happen before ANY write. That
 * is not a style preference - a read issued after a write in the same
 * transaction throws outright. So this takes the transaction handle and does
 * its `get` through it, and the caller is responsible for calling it during
 * its read phase. Getting that ordering wrong is the single most common way to
 * break a Firestore transaction, which is why every call site in
 * src/lib/wallet/ledger.ts resolves its accounts up front.
 */
export async function getAccountTx(
  tx: Transaction,
  walletId: string | null,
  type: LedgerAccountType,
  currency = 'AZN',
): Promise<{ id: string; existed: boolean; data: Omit<LedgerAccountRecord, 'id'> }> {
  const id = accountIdFor(walletId, type, currency);
  const snap = await tx.get(accounts().doc(id));
  if (snap.exists) {
    return {
      id,
      existed: true,
      data: snap.data() as Omit<LedgerAccountRecord, 'id'>,
    };
  }
  return {
    id,
    existed: false,
    data: { walletId, type, currency, createdAt: new Date() },
  };
}

/**
 * The only way money moves.
 *
 * Every transfer is a set of signed legs summing to zero. The sum is asserted
 * first, so an unbalanced posting never reaches a write - see point 1 at the
 * top of this file for exactly how much weaker that is than the constraint
 * trigger it replaces, and why the gap is closed in practice.
 *
 * The transaction document is written with `create()` rather than `set()`.
 * That distinction IS the idempotency guarantee: `set()` would silently
 * overwrite an existing posting, turning a retried purchase into a second
 * charge, which is the precise failure the unique index existed to prevent.
 */
export function postTx(
  tx: Transaction,
  params: {
    kind: LedgerTxnKind;
    referenceKey: string;
    description: string;
    legs: (Leg & { walletId: string | null; accountType: LedgerAccountType })[];
    metadata?: Record<string, unknown>;
    currency?: string;
  },
): string {
  const sum = params.legs.reduce((total, leg) => total + leg.amountMinor, 0);
  if (sum !== 0) throw new Error(`Unbalanced posting: ${sum}`);

  const currency = params.currency ?? 'AZN';
  const txnId = txnIdFor(params.referenceKey);
  const now = new Date();

  tx.create(
    transactions().doc(txnId),
    forFirestore({
      kind: params.kind,
      referenceKey: params.referenceKey,
      description: params.description,
      metadata: params.metadata ?? null,
      createdAt: now,
    }),
  );

  for (const leg of params.legs) {
    tx.create(
      entries().doc(),
      forFirestore({
        transactionId: txnId,
        accountId: leg.accountId,
        // Denormalised so GET /api/wallet can filter without a join. Safe
        // because entries are append-only; see the header.
        walletId: leg.walletId,
        accountType: leg.accountType,
        amountMinor: leg.amountMinor,
        currency,
        kind: params.kind,
        description: params.description,
        createdAt: now,
      }),
    );
  }

  return txnId;
}

/**
 * Recent activity for one wallet.
 *
 * Scoped by walletId in the QUERY, not by a filter afterwards. A ledger is the
 * one place where returning a row belonging to someone else discloses their
 * income, so the narrowing has to happen where it cannot be forgotten.
 */
export async function listWalletEntries(
  walletId: string,
  take = 50,
): Promise<LedgerEntryRecord[]> {
  const snap = await entries().where('walletId', '==', walletId).limit(500).get();
  const rows = docsToObjects<LedgerEntryRecord>(snap.docs) as LedgerEntryRecord[];
  return sortBy(rows, 'createdAt', 'desc').slice(0, take);
}

/** Sums every entry against one account. Used by reconciliation. */
export async function sumAccount(accountId: string): Promise<number> {
  const snap = await entries().where('accountId', '==', accountId).get();
  return snap.docs.reduce((total, doc) => total + Number(doc.data().amountMinor ?? 0), 0);
}

export async function listAccounts(walletId: string): Promise<LedgerAccountRecord[]> {
  const snap = await accounts().where('walletId', '==', walletId).get();
  return docsToObjects<LedgerAccountRecord>(snap.docs) as LedgerAccountRecord[];
}

/** Exposed so the wallet library can address the collections in its own transactions. */
export const ledgerCollections = { accounts, transactions, entries };
