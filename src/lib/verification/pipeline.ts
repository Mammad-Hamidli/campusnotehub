import { VerificationStatus, FraudVerdict } from '@prisma/client';
import { db } from '@/lib/db';
import { decide, publicMessageKey, toCheckScores, type Signal } from './policy';
import { stash, type BufferedDocument } from './reviewBuffer';
import { wipe } from './fileValidation';
import { enqueueNotification } from '@/lib/notifications/dispatch';

const MAX_ATTEMPTS = Number(process.env.VERIFICATION_MAX_ATTEMPTS ?? 3);

export type PipelineInput = {
  userId: string;
  caseId: string;
  documents: BufferedDocument[];
  declaredName: string;
  declaredUniversityCode: string | null;
};

export type PipelineOutcome = {
  status: VerificationStatus;
  messageKey: string;
  /** Present only when a human review was opened. Goes in the review link. */
  reviewSecret?: string;
};

/**
 * The one-time verification pipeline.
 *
 * INVARIANT, and the reason this function is written as one linear block with
 * a single `finally`: when it returns, for any reason including a thrown
 * exception, every byte of every document has been overwritten with zeroes and
 * no copy exists on any disk anywhere.
 *
 * The documents arrive as Buffers held by the request handler. They are:
 *   1. sent to the analysis service over mTLS as a multipart body,
 *   2. optionally re-encrypted into the Redis review buffer if a human is
 *      needed,
 *   3. wiped.
 *
 * They are never written to S3, never written to a temp file, never logged,
 * and never attached to an error report. There is no code path that persists
 * them, which is why there is no code path that has to remember to delete them.
 */
export async function runVerification(input: PipelineInput): Promise<PipelineOutcome> {
  let escalating = false;
  try {
    // ---- 1. Automated analysis (stateless, in-memory both sides) ----------
    const analysis = await analyse(input);

    // ---- 2. Decide -------------------------------------------------------
    const kase = await db.verificationCase.findUniqueOrThrow({
      where: { id: input.caseId },
      select: { attempt: true },
    });

    const decision = decide({
      signals: analysis.signals,
      qualityScore: analysis.qualityScore,
      attempt: kase.attempt,
      maxAttempts: MAX_ATTEMPTS,
    });

    const checkScores = toCheckScores(analysis.signals, analysis.qualityScore);
    const messageKey = publicMessageKey(decision);

    // ---- 3. Apply --------------------------------------------------------
    if (decision.outcome === 'VERIFIED') {
      await db.$transaction(async (tx) => {
        await tx.verificationCase.update({
          where: { id: input.caseId },
          data: {
            status: VerificationStatus.VERIFIED,
            verdict: FraudVerdict.CLEAN,
            confidence: decision.confidence,
            failureCodes: decision.codes,
            checkScores,
            publicMessageKey: messageKey,
            decidedAt: new Date(),
          },
        });
        await tx.user.update({
          where: { id: input.userId },
          data: {
            verificationStatus: VerificationStatus.VERIFIED,
            isVerified: true,
            verifiedAt: new Date(),
            studentStatusConfirmed: true,
            identityConfirmed: true,
          },
        });
        await enqueueNotification(tx, {
          userId: input.userId,
          type: 'VERIFICATION_APPROVED',
          titleKey: 'notifications.types.VERIFICATION_APPROVED',
          bodyKey: 'verification.submitted.body',
          linkUrl: '/dashboard',
        });
      });

      return { status: VerificationStatus.VERIFIED, messageKey };
    }

    if (decision.outcome === 'RETAKE') {
      await db.$transaction(async (tx) => {
        // decidedAt stays null and the attempt is not consumed - a bad photo
        // is not a failed attempt.
        await tx.verificationCase.update({
          where: { id: input.caseId },
          data: {
            status: VerificationStatus.REJECTED,
            confidence: decision.confidence,
            failureCodes: decision.codes,
            checkScores,
            publicMessageKey: messageKey,
          },
        });
        await tx.user.update({
          where: { id: input.userId },
          data: { verificationStatus: VerificationStatus.UNVERIFIED },
        });
      });

      return { status: VerificationStatus.REJECTED, messageKey };
    }

    // NEEDS_REVIEW: the only branch where documents outlive the request, and
    // only inside the TTL-bound encrypted Redis buffer.
    const handle = await stash(input.documents);

    await db.$transaction(async (tx) => {
      await tx.verificationCase.update({
        where: { id: input.caseId },
        data: {
          status: VerificationStatus.NEEDS_REVIEW,
          verdict: analysis.signals.some((s) => s.code === 'DIGITAL_TAMPERING')
            ? FraudVerdict.TAMPERED
            : FraudVerdict.AMBIGUOUS,
          confidence: decision.confidence,
          failureCodes: decision.codes,
          checkScores,
          publicMessageKey: messageKey,
          reviewBufferKey: handle.key,
          reviewExpiresAt: handle.expiresAt,
          reviewPriority: decision.priority,
        },
      });
      await tx.user.update({
        where: { id: input.userId },
        data: { verificationStatus: VerificationStatus.NEEDS_REVIEW },
      });
      await enqueueNotification(tx, {
        userId: input.userId,
        type: 'VERIFICATION_NEEDS_REVIEW',
        titleKey: 'notifications.types.VERIFICATION_NEEDS_REVIEW',
        bodyKey: 'verification.banner.needsReview',
        linkUrl: '/dashboard',
      });
    });

    return {
      status: VerificationStatus.NEEDS_REVIEW,
      messageKey,
      reviewSecret: handle.secret,
    };
  } catch (error) {
    // The caller escalates a pipeline outage, and escalateOnFailure still needs
    // these bytes to stash into the review buffer. Wiping them here would hand
    // the moderator an empty buffer - a NEEDS_REVIEW case with nothing to
    // review, which is the one thing the review buffer exists to prevent.
    escalating = error instanceof PipelineUnavailableError;
    throw error;
  } finally {
    // Runs on success, on rejection, and on an unhandled throw - EXCEPT when
    // the caller is about to escalate. In that one case the submit route's own
    // finally does the wipe, immediately after escalateOnFailure has copied the
    // bytes into the encrypted buffer, so they still never outlive the request.
    if (!escalating) {
      for (const doc of input.documents) wipe(doc.bytes);
      input.documents.length = 0;
    }
  }
}

/**
 * Calls the stateless analysis service.
 *
 * Sends the bytes as multipart over mTLS. The service holds them in memory,
 * returns scores, and retains nothing - it has no database credentials, no
 * object-storage credentials, and no writable volume. See
 * services/doc-verifier/app/main.py.
 *
 * What comes back is scores and category codes. The service does NOT return
 * the extracted name or ID number to us; it performs the name and university
 * comparisons internally and reports only whether they matched. That is what
 * keeps the extracted text from ever entering the Node process, where it could
 * end up in a log line or an error report.
 */
async function analyse(input: PipelineInput): Promise<{
  signals: Signal[];
  qualityScore: number;
}> {
  const form = new FormData();
  form.append('declaredName', input.declaredName);
  form.append('declaredUniversity', input.declaredUniversityCode ?? '');

  for (const doc of input.documents) {
    form.append(
      doc.kind,
      new Blob([new Uint8Array(doc.bytes)], { type: doc.mime }),
      `${doc.kind}.bin`,
    );
  }

  /**
   * A connection-level failure is an outage, not a verdict.
   *
   * `fetch` only RESOLVES for an HTTP response; DNS failure, connection
   * refused, TLS error and the 45s AbortSignal all REJECT instead - as a bare
   * TypeError/DOMException. Without this catch that error propagates past the
   * `instanceof PipelineUnavailableError` guard in the submit route and the
   * user gets a 500, which is precisely the "our outage reads as your fraud"
   * outcome the escalation path below exists to prevent. An unreachable
   * verifier is the single most likely failure here, so it must take the same
   * NEEDS_REVIEW route as a 503 from a verifier that did answer.
   */
  let response: Response;
  try {
    response = await fetch(`${process.env.DOC_VERIFIER_URL}/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.DOC_VERIFIER_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new PipelineUnavailableError(`doc-verifier unreachable (${reason})`);
  }

  if (!response.ok) {
    // A pipeline failure must never look like a fraud outcome. Escalating to a
    // human is the safe direction: the user is not penalised for our outage.
    throw new PipelineUnavailableError(`doc-verifier returned ${response.status}`);
  }

  const body = (await response.json()) as {
    signals: Signal[];
    qualityScore: number;
  };

  return { signals: body.signals ?? [], qualityScore: body.qualityScore ?? 0 };
}

export class PipelineUnavailableError extends Error {
  readonly messageKey = 'verification.banner.needsReview';
}

/**
 * Fallback when the analysis service is unreachable.
 *
 * Parks the case for human review rather than guessing. The documents still go
 * through the same TTL-bound buffer, and the user still gets an honest status
 * instead of a spurious rejection.
 */
export async function escalateOnFailure(input: PipelineInput): Promise<PipelineOutcome> {
  try {
    const handle = await stash(input.documents);

    await db.$transaction(async (tx) => {
      await tx.verificationCase.update({
        where: { id: input.caseId },
        data: {
          status: VerificationStatus.NEEDS_REVIEW,
          verdict: FraudVerdict.AMBIGUOUS,
          failureCodes: ['PIPELINE_UNAVAILABLE'],
          publicMessageKey: 'verification.banner.needsReview',
          reviewBufferKey: handle.key,
          reviewExpiresAt: handle.expiresAt,
          reviewPriority: 80, // our fault, not theirs - review it quickly
        },
      });
      await tx.user.update({
        where: { id: input.userId },
        data: { verificationStatus: VerificationStatus.NEEDS_REVIEW },
      });
    });

    return {
      status: VerificationStatus.NEEDS_REVIEW,
      messageKey: 'verification.banner.needsReview',
      reviewSecret: handle.secret,
    };
  } finally {
    for (const doc of input.documents) wipe(doc.bytes);
    input.documents.length = 0;
  }
}
