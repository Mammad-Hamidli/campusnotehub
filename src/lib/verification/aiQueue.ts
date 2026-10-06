import { randomUUID } from 'node:crypto';
import { AccountStatus, FraudVerdict, VerificationStatus } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { forFirestore } from '@/lib/firebase/convert';
import {
  AiCheckState,
  aiQueuedCases,
  createCase,
  findCaseById,
  type VerificationCaseRecord,
} from '@/lib/firebase/repositories/verification';
import { findUserById, updateUser } from '@/lib/firebase/repositories/users';
import { findUniversityById } from '@/lib/firebase/repositories/reference';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { enqueueNotificationTx } from '@/lib/notifications/dispatch';
import { sendEmail } from '@/lib/email/send';
import { verificationAlertInbox } from '@/lib/email/identity';
import { destroy, retrieve, stash, type BufferedDocument } from './reviewBuffer';
import { wipe } from './fileValidation';
import { requirementReasonFor } from './requirements';
import {
  EXTRACTION_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  INTEGRITY_CODES,
  compare,
  parseExtraction,
  type CheckOutcome,
  type CheckedDocument,
} from './documentCheck';
import { runVisionModel, WorkersAiStopError } from './workersAi';

/**
 * The verification queue: submissions wait "under review" and a nightly batch
 * reads them with Cloudflare's vision model, oldest first.
 *
 *   submit   POST /api/verification/submit -> enqueueSubmission(): documents
 *            go to the review buffer (Cloudinary, authenticated, 7-day cap),
 *            the case is NEEDS_REVIEW + aiCheckState QUEUED, and so is the user.
 *   midnight GET /api/cron/verification-ai (Vercel Cron) or the scheduler
 *            worker -> runAiVerificationBatch().
 *   per case complete match  -> VERIFIED, documents destroyed, user told;
 *            anything else     -> stays NEEDS_REVIEW, FLAGGED, staff emailed.
 *
 * Moderators can decide a queued case at any time from /admin/verifications;
 * the batch re-reads every case inside a transaction before writing and never
 * overwrites a human decision.
 *
 * ---------------------------------------------------------------------------
 * FIFO AND THE DAILY AI LIMIT
 * ---------------------------------------------------------------------------
 * The queue is every QUEUED case ordered by submittedAt. A case leaves it only
 * when it is decided (APPROVED / FLAGGED / SKIPPED). When Workers AI says the
 * daily neuron allocation is used up - or is down, or misconfigured - the
 * batch stops BEFORE writing anything for the case in hand, so that case and
 * every one behind it are still QUEUED, in the same order, and the next run
 * starts with exactly the case this one could not finish. That is the whole
 * resume mechanism: no cursor to lose or corrupt, because the queue is the
 * cursor.
 *
 * A run on Vercel is also bounded by the function's time limit. Running out
 * of time is the same safe stop; the cron route then hands over to a fresh
 * invocation (see the route) so a long queue still drains the same night.
 *
 * Only one batch runs at a time: a lease in siteConfig/verificationAiBatch.
 */

/** The documents the model reads. Backs carry nothing the comparison uses. */
const ID_KIND = 'ID_FRONT';
const CARD_KIND = 'STUDENT_CARD_FRONT';

/** Head-room kept before the deadline for one more case (two model calls). */
const PER_CASE_RESERVE_MS = 45_000;

const LEASE_DOC = 'verificationAiBatch';

/** Flagged cases sort above unchecked ones in the moderator queue. */
const FLAGGED_PRIORITY = 40;
const INTEGRITY_PRIORITY_BONUS = 25;

export type BatchStopReason =
  | 'QUEUE_EMPTY'
  | 'AI_QUOTA'
  | 'AI_UNAVAILABLE'
  | 'AI_CONFIG'
  | 'STORAGE_UNAVAILABLE'
  | 'TIME_BUDGET'
  | 'LEASE_HELD';

export type BatchResult = {
  runId: string;
  processed: number;
  approved: number;
  flagged: number;
  skipped: number;
  remaining: number;
  stoppedReason: BatchStopReason;
  /** Diagnostic for an early stop: status and error codes, never document data. */
  stoppedDetail: string | null;
};

class StorageUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Submit side
// ---------------------------------------------------------------------------

/**
 * Parks a validated submission for tonight's batch.
 *
 * The caller wipes `documents` afterwards, as with stash(). Order: buffer,
 * then case, then account flag. A failed case write destroys the buffer it was
 * about to point at, so no upload outlives a failed submission; a failed
 * account write after that leaves a QUEUED case, which the batch still decides.
 */
export async function enqueueSubmission(input: {
  userId: string;
  caseId: string;
  attempt: number;
  documents: BufferedDocument[];
}): Promise<VerificationCaseRecord> {
  const handle = await stash(input.documents);

  let kase: VerificationCaseRecord;
  try {
    kase = await createCase({
      id: input.caseId,
      userId: input.userId,
      attempt: input.attempt,
      status: VerificationStatus.NEEDS_REVIEW,
      review: { bufferKey: handle.key, expiresAt: handle.expiresAt, documents: handle.documents },
      aiCheckState: AiCheckState.QUEUED,
    });
  } catch (error) {
    await destroy(handle.key).catch(() => {});
    throw error;
  }

  await updateUser(input.userId, { verificationStatus: VerificationStatus.NEEDS_REVIEW });
  return kase;
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

function leaseRef() {
  return adminDb().collection(COLLECTIONS.siteConfig).doc(LEASE_DOC);
}

async function acquireLease(runId: string, until: Date): Promise<boolean> {
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(leaseRef());
    // A Timestamp from Firestore; a Date from the in-memory fake in tests.
    const held = snap.get('leaseUntil') as { toMillis?: () => number } | Date | undefined;
    const heldUntil = held instanceof Date ? held.getTime() : (held?.toMillis?.() ?? 0);
    if (heldUntil > Date.now()) return false;
    tx.set(leaseRef(), { holder: runId, leaseUntil: until, startedAt: new Date() }, { merge: true });
    return true;
  });
}

async function releaseLease(runId: string, result: BatchResult): Promise<void> {
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(leaseRef());
    if (snap.get('holder') !== runId) return;
    tx.set(
      leaseRef(),
      forFirestore({ holder: null, leaseUntil: new Date(0), lastRun: { ...result, finishedAt: new Date() } }),
      { merge: true },
    );
  });
}

/**
 * Processes queued cases, oldest first, until the queue is empty, the AI
 * allocation runs out, or `deadline` (epoch ms) is near.
 */
export async function runAiVerificationBatch(
  options: { deadline?: number; now?: () => Date } = {},
): Promise<BatchResult> {
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const now = options.now ?? (() => new Date());
  const runId = randomUUID();

  const result: BatchResult = {
    runId,
    processed: 0,
    approved: 0,
    flagged: 0,
    skipped: 0,
    remaining: 0,
    stoppedReason: 'QUEUE_EMPTY',
    stoppedDetail: null,
  };

  // Lease to the deadline plus a margin; an unbounded run (the worker) holds
  // it for an hour at a time and renews it per case.
  const leaseFor = () =>
    new Date(Number.isFinite(deadline) ? deadline + 60_000 : Date.now() + 60 * 60_000);
  if (!(await acquireLease(runId, leaseFor()))) {
    return { ...result, stoppedReason: 'LEASE_HELD' };
  }

  const flaggedCases: { caseId: string; codes: string[] }[] = [];
  try {
    const queue = await aiQueuedCases();
    result.remaining = queue.length;

    for (const queued of queue) {
      if (Date.now() + PER_CASE_RESERVE_MS > deadline) {
        result.stoppedReason = 'TIME_BUDGET';
        break;
      }
      if (!Number.isFinite(deadline)) {
        await leaseRef().set({ leaseUntil: leaseFor() }, { merge: true });
      }

      let outcome: CaseOutcome;
      try {
        outcome = await processCase(queued.id, now());
      } catch (error) {
        if (error instanceof WorkersAiStopError) {
          result.stoppedReason =
            error.reason === 'QUOTA' ? 'AI_QUOTA' : error.reason === 'CONFIG' ? 'AI_CONFIG' : 'AI_UNAVAILABLE';
          result.stoppedDetail = error.message;
          break;
        }
        if (error instanceof StorageUnavailableError) {
          result.stoppedReason = 'STORAGE_UNAVAILABLE';
          result.stoppedDetail = error.message;
          break;
        }
        // A bug or a database error on ONE case must not hold up everyone
        // behind it: hand the case to a human and move on.
        console.error('[verification-ai] case %s failed: %s', queued.id, (error as Error)?.name ?? 'Error');
        outcome = await flagCase(queued.id, flagOutcome(['AI_CHECK_FAILED']), now()).catch(() => 'UNCHANGED' as const);
      }

      result.processed += 1;
      result.remaining -= 1;
      if (outcome === 'APPROVED') result.approved += 1;
      else if (outcome === 'SKIPPED' || outcome === 'UNCHANGED') result.skipped += 1;
      else {
        result.flagged += 1;
        flaggedCases.push({ caseId: queued.id, codes: outcome.codes });
      }
    }
  } finally {
    await releaseLease(runId, result).catch((error) =>
      console.error('[verification-ai] could not release the batch lease', error),
    );
  }

  console.info(
    '[verification-ai] run %s: %d processed (%d approved, %d flagged, %d skipped), %d queued, stopped: %s',
    runId,
    result.processed,
    result.approved,
    result.flagged,
    result.skipped,
    result.remaining,
    result.stoppedReason,
  );

  await alertStaff(result, flaggedCases);
  return result;
}

/** Plain-language reasons for the staff email. */
const STOP_MESSAGES: Partial<Record<BatchStopReason, string>> = {
  AI_QUOTA:
    'The Cloudflare Workers AI daily allocation ran out. The remaining cases stay under review and are checked first at the next nightly run.',
  AI_UNAVAILABLE:
    'Cloudflare Workers AI did not answer. The remaining cases stay under review and are retried at the next nightly run.',
  AI_CONFIG:
    'Cloudflare Workers AI refused the request (account id, API token, or the Llama 3.2 licence has not been accepted). Nothing is checked automatically until this is fixed; see the server log.',
  STORAGE_UNAVAILABLE:
    'The verification images could not be fetched from Cloudinary. The remaining cases are retried at the next nightly run.',
};

/**
 * Awaited, not sendEmailAsync(): the batch already runs in the background
 * (after() on Vercel, the worker, or a CLI run that exits when it returns),
 * so there is no response to protect - only a process that must not exit with
 * a mail half-sent. sendEmail() never rejects; a failure is parked in the
 * outbox.
 */
async function alertStaff(result: BatchResult, flagged: { caseId: string; codes: string[] }[]): Promise<void> {
  const stopped = STOP_MESSAGES[result.stoppedReason] ?? null;
  if (flagged.length === 0 && !stopped) return;
  await sendEmail(
    verificationAlertInbox(),
    'verificationAiDigest',
    { flagged, approved: result.approved, remaining: result.remaining, stopped },
    { dedupeKey: `verification-ai-digest:${result.runId}` },
  );
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

type CaseOutcome = 'APPROVED' | 'SKIPPED' | 'UNCHANGED' | { codes: string[] };

function flagOutcome(codes: string[]): CheckOutcome {
  return { outcome: 'FLAG', codes, scores: {}, confidence: 0 };
}

/**
 * Reads, compares and decides one case. Throws WorkersAiStopError or
 * StorageUnavailableError - having written nothing - when the batch must stop.
 */
async function processCase(caseId: string, now: Date): Promise<CaseOutcome> {
  const kase = await findCaseById(caseId);
  if (
    !kase ||
    kase.aiCheckState !== AiCheckState.QUEUED ||
    kase.status !== VerificationStatus.NEEDS_REVIEW ||
    kase.dismissedAt
  ) {
    return 'UNCHANGED'; // decided by a moderator since the queue was read
  }

  const user = await findUserById(kase.userId);
  if (!user || user.accountStatus === AccountStatus.BANNED || user.accountStatus === AccountStatus.DELETED) {
    return settle(caseId, { aiCheckState: AiCheckState.SKIPPED, aiCheckedAt: now }).then(() => 'SKIPPED' as const);
  }

  const needsCard = requirementReasonFor(user.role) === 'STUDYING';
  const kinds = needsCard ? [ID_KIND, CARD_KIND] : [ID_KIND];
  const stored = (kase.reviewDocuments ?? []).filter((doc) => kinds.includes(doc.kind));
  if (!kase.reviewBufferKey || stored.length !== kinds.length) {
    return flagCase(caseId, flagOutcome(['DOCUMENTS_UNAVAILABLE']), now);
  }

  let documents: BufferedDocument[] | null;
  try {
    documents = await retrieve({ key: kase.reviewBufferKey, expiresAt: kase.reviewExpiresAt, documents: stored });
  } catch (error) {
    throw new StorageUnavailableError(`review buffer fetch failed (${(error as Error)?.name ?? 'Error'})`);
  }
  if (!documents) return flagCase(caseId, flagOutcome(['DOCUMENTS_UNAVAILABLE']), now);

  let check: CheckOutcome;
  try {
    const checked: CheckedDocument[] = [];
    for (const doc of documents) {
      const raw = await runVisionModel({ system: EXTRACTION_SYSTEM_PROMPT, prompt: EXTRACTION_PROMPT, jpeg: doc.bytes });
      checked.push({ kind: doc.kind, extraction: parseExtraction(raw) });
    }

    const university = needsCard && user.universityId ? await findUniversityById(user.universityId) : null;
    check = compare(
      checked,
      {
        fullName: user.fullName,
        firstName: user.firstName,
        lastName: user.lastName,
        dateOfBirth: user.dateOfBirth,
        // A student with no university on file cannot match a card: an empty
        // name list makes that a UNIVERSITY_MISMATCH flag, not an approval.
        university: needsCard
          ? university
            ? { code: university.code, names: [university.nameEn, university.nameAz, university.nameRu] }
            : { code: '', names: [] }
          : null,
      },
      now,
    );
  } finally {
    for (const doc of documents) wipe(doc.bytes);
    documents.length = 0;
  }

  if (check.outcome === 'APPROVE') return approveCase(kase, check, now);
  return flagCase(caseId, check, now);
}

/**
 * Applies a patch to a case only if it is still waiting for this batch.
 * Returns whether it applied - false means a moderator got there first.
 */
async function settle(
  caseId: string,
  casePatch: Record<string, unknown>,
  extra?: (tx: FirebaseFirestore.Transaction) => void,
): Promise<boolean> {
  const caseRef = adminDb().collection(COLLECTIONS.verificationCases).doc(caseId);
  return adminDb().runTransaction(async (tx) => {
    const live = (await tx.get(caseRef)).data();
    if (
      !live ||
      live.aiCheckState !== AiCheckState.QUEUED ||
      live.status !== VerificationStatus.NEEDS_REVIEW ||
      live.dismissedAt
    ) {
      return false;
    }
    tx.update(caseRef, forFirestore(casePatch));
    extra?.(tx);
    return true;
  });
}

async function approveCase(kase: VerificationCaseRecord, check: CheckOutcome, now: Date): Promise<CaseOutcome> {
  const userRef = adminDb().collection(COLLECTIONS.users).doc(kase.userId);

  /**
   * Decision first, documents second - the reverse of the moderator route.
   * There, the moderator owns the case outright; here the transaction is what
   * establishes that this batch still owns it, so the buffer cannot be
   * destroyed before it. If destroy() then fails, the decision stands and the
   * Firestore-independent sweepExpiredAssets() removes the images within the
   * 7-day cap.
   */
  const applied = await settle(
    kase.id,
    {
      status: VerificationStatus.VERIFIED,
      verdict: FraudVerdict.CLEAN,
      confidence: check.confidence,
      failureCodes: [],
      checkScores: check.scores,
      publicMessageKey: 'verification.badge.verified',
      decidedAt: now,
      aiCheckState: AiCheckState.APPROVED,
      aiCheckedAt: now,
      reviewBufferKey: null,
      reviewExpiresAt: null,
      reviewDocuments: null,
    },
    (tx) => {
      tx.update(
        userRef,
        forFirestore({
          verificationStatus: VerificationStatus.VERIFIED,
          isVerified: true,
          verifiedAt: now,
          studentStatusConfirmed: true,
          identityConfirmed: true,
          updatedAt: now,
        }),
      );
      enqueueNotificationTx(tx, {
        userId: kase.userId,
        type: 'VERIFICATION_APPROVED',
        titleKey: 'notifications.types.VERIFICATION_APPROVED',
        bodyKey: 'verification.submitted.body',
        linkUrl: '/dashboard',
      });
    },
  );
  if (!applied) return 'UNCHANGED';

  if (kase.reviewBufferKey) {
    await destroy(kase.reviewBufferKey).catch((error) =>
      console.error('[verification-ai] could not destroy buffer for case %s', kase.id, error),
    );
  }

  await writeAuditLog({
    actorId: null,
    action: 'KYC_AUTO_APPROVED',
    entityType: 'verification_case',
    entityId: kase.id,
    after: { userId: kase.userId, confidence: check.confidence, scores: check.scores },
    result: 'SUCCESS',
  }).catch((error) => console.error('[verification-ai] audit write failed for case %s', kase.id, error));

  const applicant = await findUserById(kase.userId);
  if (applicant?.email) {
    await sendEmail(
      applicant.email,
      'verificationApproved',
      { nickname: applicant.nickname },
      { dedupeKey: `verification-decision:${kase.id}` },
    );
  }
  return 'APPROVED';
}

async function flagCase(caseId: string, check: CheckOutcome, now: Date): Promise<CaseOutcome> {
  const integrity = check.codes.some((code) => INTEGRITY_CODES.has(code));
  const applied = await settle(caseId, {
    aiCheckState: AiCheckState.FLAGGED,
    aiCheckedAt: now,
    verdict: integrity ? FraudVerdict.TAMPERED : FraudVerdict.AMBIGUOUS,
    confidence: check.confidence,
    failureCodes: check.codes,
    checkScores: check.scores,
    reviewPriority: FLAGGED_PRIORITY + (integrity ? INTEGRITY_PRIORITY_BONUS : 0),
    publicMessageKey: 'verification.banner.needsReview',
  });
  return applied ? { codes: check.codes } : 'UNCHANGED';
}
