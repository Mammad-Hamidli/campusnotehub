import type { StoredReviewDocument } from '@/lib/verification/reviewBuffer';
import type { FraudVerdict, VerificationStatus } from '@/lib/enums';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore, sortBy } from '../convert';

/**
 * Verification cases - the moderation queue for identity checks.
 *
 * ===========================================================================
 * WHAT IS AND IS NOT IN THESE DOCUMENTS
 * ===========================================================================
 * No document bytes, no extracted text, no name read off a student card. A
 * case carries scores, category CODES and a pointer to an ephemeral encrypted
 * buffer - and that is the entire retention story. The Postgres schema
 * enforced the "numbers only" half of that with a CHECK constraint on
 * `checkScores` in 0002_zero_retention.sql; Firestore has no CHECK, so the
 * assertion moved into writeCheckScores() below, which is the only writer of
 * that field.
 *
 * That is a real reduction in enforcement and worth naming: the constraint
 * caught a bad write from ANY client, this catches it only from application
 * code. What closes the gap is that the security rules deny this collection to
 * every client outright, so application code is the only writer there is.
 *
 * `reviewBufferKey` still points at a blob that lives outside the database
 * under a hard expiry - see src/lib/verification/reviewBuffer.ts, and read its
 * header before touching anything here that mentions retention.
 */

export type VerificationCaseRecord = {
  id: string;
  userId: string;
  status: VerificationStatus;
  attempt: number;
  submittedAt: Date;
  decidedAt: Date | null;
  verdict: FraudVerdict | null;
  confidence: number | null;
  failureCodes: string[];
  checkScores: Record<string, number> | null;
  publicMessageKey: string | null;
  reviewBufferKey: string | null;
  reviewExpiresAt: Date | null;
  /** Cloudinary identifiers for the buffered documents - never bytes. */
  reviewDocuments: StoredReviewDocument[] | null;
  reviewPriority: number;
  decidedByModeratorId: string | null;
  moderatorNote: string | null;
  dismissedAt: Date | null;
  dismissedById: string | null;
};

const cases = () => adminDb().collection(COLLECTIONS.verificationCases);

export function newCaseId(): string {
  return cases().doc().id;
}

/**
 * Rejects any non-numeric check score.
 *
 * This is the CHECK constraint from 0002_zero_retention.sql, re-expressed. Its
 * purpose is not type hygiene: it is to stop `checkScores` becoming a back
 * door for retaining extracted text. A string value here would be a quoted
 * fragment of somebody's identity document sitting in a database that is
 * explicitly promised to hold none.
 */
function assertNumericScores(scores: Record<string, unknown> | null | undefined): void {
  if (!scores) return;
  for (const [key, value] of Object.entries(scores)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`checkScores.${key} must be a finite number, got ${typeof value}`);
    }
  }
}

export async function findCaseById(id: string): Promise<VerificationCaseRecord | null> {
  return docToObject<VerificationCaseRecord>(
    await cases().doc(id).get(),
  ) as VerificationCaseRecord | null;
}

export async function createCase(params: {
  id: string;
  userId: string;
  attempt: number;
  status: VerificationStatus;
}): Promise<VerificationCaseRecord> {
  const record = {
    userId: params.userId,
    status: params.status,
    attempt: params.attempt,
    submittedAt: new Date(),
    decidedAt: null,
    verdict: null,
    confidence: null,
    failureCodes: [] as string[],
    checkScores: null,
    publicMessageKey: null,
    reviewBufferKey: null,
    reviewExpiresAt: null,
    reviewDocuments: null,
    reviewPriority: 0,
    decidedByModeratorId: null,
    moderatorNote: null,
    dismissedAt: null,
    dismissedById: null,
  };
  await cases().doc(params.id).set(forFirestore(record));
  return { id: params.id, ...record } as VerificationCaseRecord;
}

export async function updateCase(id: string, patch: Record<string, unknown>): Promise<void> {
  if ('checkScores' in patch) {
    assertNumericScores(patch.checkScores as Record<string, unknown> | null);
  }
  await cases().doc(id).update(forFirestore(patch));
}

/** How many times this user has already submitted. Caps retries. */
export async function countAttempts(userId: string): Promise<number> {
  return (await cases().where('userId', '==', userId).count().get()).data().count;
}

export async function latestCaseForUser(userId: string): Promise<VerificationCaseRecord | null> {
  const snap = await cases().where('userId', '==', userId).limit(50).get();
  const rows = sortBy(
    docsToObjects<VerificationCaseRecord>(snap.docs) as VerificationCaseRecord[],
    'submittedAt',
    'desc',
  );
  return rows[0] ?? null;
}

export type CaseListFilter = {
  status?: VerificationStatus;
  verdict?: FraudVerdict;
  userId?: string;
  includeDismissed?: boolean;
  submittedFrom?: Date;
  submittedTo?: Date;
};

/**
 * The moderator queue and the admin case table.
 *
 * Same shape as listUsers(): push the equality filters Firestore can index,
 * then order and page the narrowed set in memory. The queue's natural order -
 * `status, reviewPriority DESC, submittedAt` - is a three-field sort that
 * would otherwise need its own composite index for every filter combination an
 * operator can select from the UI.
 */
const QUEUE_SCAN_CEILING = 2000;

export async function listCases(
  filter: CaseListFilter,
  page: number,
  pageSize: number,
  sort: string,
  order: 'asc' | 'desc',
): Promise<{ cases: VerificationCaseRecord[]; total: number }> {
  let query: FirebaseFirestore.Query = cases();
  if (filter.status) query = query.where('status', '==', filter.status);
  if (filter.verdict) query = query.where('verdict', '==', filter.verdict);
  if (filter.userId) query = query.where('userId', '==', filter.userId);

  const snap = await query.limit(QUEUE_SCAN_CEILING).get();
  let rows = docsToObjects<VerificationCaseRecord>(snap.docs) as VerificationCaseRecord[];

  if (!filter.includeDismissed) rows = rows.filter((c) => !c.dismissedAt);
  if (filter.submittedFrom) rows = rows.filter((c) => c.submittedAt >= filter.submittedFrom!);
  if (filter.submittedTo) rows = rows.filter((c) => c.submittedAt <= filter.submittedTo!);

  const total = rows.length;
  const sorted = sortBy(rows, sort as keyof VerificationCaseRecord, order);
  return { cases: sorted.slice((page - 1) * pageSize, page * pageSize), total };
}

/**
 * The review queue proper: undecided cases, most urgent first.
 *
 * Priority then age, which is what `reviewPriority DESC, submittedAt ASC`
 * expressed. The escalation path sets priority 80 for "our pipeline was down",
 * so an outage does not leave honest students behind a backlog they did not
 * cause.
 */
export async function reviewQueue(take = 50): Promise<VerificationCaseRecord[]> {
  const snap = await cases()
    .where('status', '==', 'NEEDS_REVIEW')
    .limit(QUEUE_SCAN_CEILING)
    .get();
  const rows = (docsToObjects<VerificationCaseRecord>(snap.docs) as VerificationCaseRecord[])
    .filter((c) => !c.dismissedAt)
    .sort(
      (a, b) =>
        (b.reviewPriority ?? 0) - (a.reviewPriority ?? 0) ||
        a.submittedAt.getTime() - b.submittedAt.getTime(),
    );
  return rows.slice(0, take);
}

/**
 * Cases whose review window has lapsed.
 *
 * `reviewBufferKey != null` is a Firestore inequality, and a query may carry a
 * range on only one field - so the range goes on `reviewExpiresAt`, which is
 * the one that actually narrows, and the null check is applied to the result.
 */
export async function expiredReviewCases(
  now: Date,
  take = 500,
): Promise<VerificationCaseRecord[]> {
  const snap = await cases().where('reviewExpiresAt', '<', now).limit(take).get();
  return (docsToObjects<VerificationCaseRecord>(snap.docs) as VerificationCaseRecord[]).filter(
    (c) => c.reviewBufferKey !== null && c.reviewBufferKey !== undefined,
  );
}

export async function countCases(where: Record<string, unknown> = {}): Promise<number> {
  let query: FirebaseFirestore.Query = cases();
  for (const [field, value] of Object.entries(where)) query = query.where(field, '==', value);
  return (await query.count().get()).data().count;
}

export const verificationCollections = { cases };
