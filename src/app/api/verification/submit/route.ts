import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus } from '@/lib/enums';
import { findUserById, updateUser } from '@/lib/firebase/repositories/users';
import { findUniversityById } from '@/lib/firebase/repositories/reference';
import {
  createCase,
  newCaseId,
  listCases,
  updateCase,
} from '@/lib/firebase/repositories/verification';
import { requireSession } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { isUserBlocked } from '@/lib/security/blocklist';
import { sendEmailAsync } from '@/lib/email/send';
import {
  MAX_UPLOAD_BYTES,
  MAX_TOTAL_BYTES,
  validateDocument,
  wipe,
  type ValidationFailure,
} from '@/lib/verification/fileValidation';
import {
  runVerification,
  escalateOnFailure,
  PipelineUnavailableError,
  type PipelineInput,
} from '@/lib/verification/pipeline';
import { requiredKindsFor } from '@/lib/verification/requirements';

// Must be the Node runtime: the pipeline holds Buffers and calls node:crypto.
export const runtime = 'nodejs';
// Never cache, never prerender. This route handles identity documents.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_ATTEMPTS = Number(process.env.VERIFICATION_MAX_ATTEMPTS ?? 3);

/**
 * Which documents each account must submit is decided by requiredKindsFor()
 * in src/lib/verification/requirements.ts - the same function the settings
 * screen renders from - applied to the role read from the DATABASE below, not
 * to anything in the request. A client cannot shrink its own requirements.
 *
 *   STUDENT          - national ID + student ID
 *   ALUMNI, MENTOR,
 *   TEACHER          - national ID only
 */

/**
 * POST /api/verification/submit
 *
 * The single entry point for identity verification, and the only place in the
 * codebase where a national ID image exists.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THE OLD SHAPE WAS WRONG
 * ---------------------------------------------------------------------------
 * The previous design uploaded documents to S3 with a presigned POST, opened a
 * case, enqueued a background job, and scheduled a purge 30 days later. That
 * shape is incompatible with a zero-retention promise no matter how careful
 * the purge job is, because:
 *
 *   - S3 versioning and lifecycle rules keep deleted objects recoverable;
 *   - a queued job means documents sit in storage for however long the queue
 *     is backed up, which is unbounded during an incident;
 *   - "we delete after 30 days" is a retention policy, not zero retention.
 *
 * The request now does the whole thing inline: read the multipart body into
 * memory under a hard cap, validate the bytes, run the analysis, decide, and
 * wipe. Nothing is written to durable storage at any point. The only branch
 * where documents survive the response is NEEDS_REVIEW, which parks them in a
 * 7-day authenticated Cloudinary buffer so a human can actually review them - see
 * src/lib/verification/reviewBuffer.ts for why that compromise is necessary
 * and how it is bounded.
 *
 * Cost of doing it inline: the request takes 3-8 seconds instead of returning
 * instantly. That is an acceptable trade for a one-time action the user
 * expects to take a moment, and the UI shows real per-check progress.
 */
export async function POST(request: NextRequest) {
  const { userId } = await requireSession(request);
  const ip = clientIp(request.headers);

  // Rate limit BEFORE reading the body, so a flood costs us a Redis round trip
  // rather than 20 MB of buffering per request.
  const limit = await rateLimit('verification:submit', { userId, ip });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  if (await isUserBlocked(userId)) {
    return NextResponse.json({ error: 'verification.failure.generic' }, { status: 403 });
  }

  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  }

  // The institution CODE, which the verifier compares the student card
  // against. A separate read where Prisma had a join, and issued before the
  // status guards below only because every branch that proceeds needs it.
  const university = user.universityId ? await findUniversityById(user.universityId) : null;

  if (user.verificationStatus === VerificationStatus.VERIFIED) {
    return NextResponse.json({ error: 'already_verified' }, { status: 409 });
  }
  if (user.accountStatus === 'BANNED') {
    return NextResponse.json({ error: 'verification.failure.generic' }, { status: 403 });
  }
  if (user.verificationStatus === VerificationStatus.NEEDS_REVIEW) {
    return NextResponse.json({ error: 'verification.banner.needsReview' }, { status: 409 });
  }

  // Only decided attempts count. A RETAKE leaves decidedAt null, so a blurry
  // photo never burns one of the three.
  const priorAttempts = (
    await listCases({ userId, includeDismissed: true }, 1, 100, 'submittedAt', 'desc')
  ).cases.filter((c) => c.decidedAt !== null).length;
  if (priorAttempts >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: 'verification.banner.attemptsExhausted', needsSupport: true },
      { status: 429 },
    );
  }

  // ---- Read and validate the four documents -------------------------------
  const documents: PipelineInput['documents'] = [];

  try {
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (contentLength > MAX_TOTAL_BYTES) {
      // Content-Length is a client claim, so this is only a fast reject. The
      // real cap is enforced per-part below while parsing.
      return NextResponse.json({ error: 'errors.fileTooLarge' }, { status: 413 });
    }

    const form = await request.formData();

    /**
     * Consent, taken HERE rather than at registration.
     *
     * Identity documents are special-category data. Consent to process them
     * has to be specific and informed, which means it has to be given at the
     * point the processing is actually described and about to happen - not
     * bundled into a signup checkbox weeks earlier, next to the terms of
     * service, for an upload the person had not yet been shown.
     *
     * So this is the gate: no consent, no processing, and the bytes are never
     * read. The refusal comes before formData's files are touched for exactly
     * that reason.
     */
    if (form.get('consentDocumentProcessing') !== 'true') {
      return NextResponse.json({ error: 'auth.errors.consentRequired' }, { status: 400 });
    }

    // Chosen from the account's own role, read from the database above.
    const requiredKinds = requiredKindsFor(user.role);

    for (const kind of requiredKinds) {
      const entry = form.get(kind);
      if (!(entry instanceof File)) {
        return NextResponse.json(
          { error: 'errors.validationFailed', missing: kind },
          { status: 400 },
        );
      }
      if (entry.size > MAX_UPLOAD_BYTES) {
        return failValidation('FILE_TOO_LARGE', kind);
      }

      const bytes = Buffer.from(await entry.arrayBuffer());
      const verdict = validateDocument(bytes, entry.type);

      if (!verdict.ok) {
        wipe(bytes);
        return failValidation(verdict.reason, kind);
      }

      documents.push({ kind, mime: verdict.mime, bytes });
    }

    // ---- Open the case, then run the pipeline -----------------------------
    /**
     * The case first, then the account flag.
     *
     * These shared a transaction; they no longer can, because createCase()
     * and updateUser() each open their own write. The order is chosen so the
     * survivable failure is the one that happens: a case with no PROCESSING
     * flag is a row the pipeline will still decide, while a PROCESSING flag
     * with no case would leave an account stuck in a state that nothing owns
     * and nothing can clear.
     */
    const kase = await createCase({
      id: newCaseId(),
      userId,
      attempt: priorAttempts + 1,
      status: VerificationStatus.PROCESSING,
    });

    await updateUser(userId, { verificationStatus: VerificationStatus.PROCESSING });

    const input: PipelineInput = {
      userId,
      caseId: kase.id,
      documents,
      declaredName: user.fullName,
      declaredUniversityCode: university?.code ?? null,
    };

    let outcome;
    try {
      try {
        // runVerification wipes `documents` in its own finally block.
        outcome = await runVerification(input);
      } catch (error) {
        if (error instanceof PipelineUnavailableError) {
          // Our outage must never read as the user's fraud. Park it for a human.
          outcome = await escalateOnFailure(input);
        } else {
          throw error;
        }
      }
    } catch (error) {
      /**
       * Neither a verdict nor a parked review was committed (e.g. the review
       * buffer upload to Cloudinary failed). Undo the PROCESSING flag set above
       * so the account is not stuck in a state nothing will ever clear, and
       * close the case like a RETAKE - decidedAt stays null, so our failure
       * does not burn one of the user's attempts.
       */
      console.error('[verification] submission %s failed', kase.id, error);
      await Promise.allSettled([
        updateCase(kase.id, {
          status: VerificationStatus.REJECTED,
          failureCodes: ['SUBMISSION_FAILED'],
          publicMessageKey: 'errors.generic',
        }),
        updateUser(userId, { verificationStatus: VerificationStatus.UNVERIFIED }),
      ]);
      return NextResponse.json({ error: 'errors.generic' }, { status: 503 });
    }

    /**
     * "We have your documents" - sent for every outcome, including the ones
     * decided in the same second.
     *
     * The message says the submission was received and that the documents are
     * not stored, and deliberately does NOT state the verdict: an approval or
     * a rejection gets its own email from the decision path, so announcing the
     * result twice from two places would be the way those two messages
     * eventually start disagreeing.
     */
    sendEmailAsync(user.email, 'verificationSubmitted', { nickname: user.nickname });

    return NextResponse.json(
      {
        caseId: kase.id,
        status: outcome.status,
        attempt: kase.attempt,
        remainingAttempts: Math.max(0, MAX_ATTEMPTS - (priorAttempts + 1)),
        messageKey: outcome.messageKey,
      },
      { status: 200 },
    );
  } finally {
    // Defence in depth. The pipeline already wipes on every path; this catches
    // the cases that fail before it is ever called (validation rejection, a
    // malformed multipart body, a thrown transaction).
    for (const doc of documents) wipe(doc.bytes);
    documents.length = 0;
  }
}

/**
 * Validation failures map to specific, actionable locale keys - unlike fraud
 * outcomes, which are deliberately generic. Telling someone their photo is
 * blurry helps them; telling someone which forgery check fired helps them
 * forge better.
 */
function failValidation(reason: ValidationFailure, kind: string) {
  const key: Record<ValidationFailure, string> = {
    FILE_TOO_LARGE: 'verification.quality.tooLarge',
    FILE_EMPTY: 'errors.validationFailed',
    MIME_NOT_ALLOWED: 'verification.quality.wrongFormat',
    MIME_MISMATCH: 'verification.quality.wrongFormat',
    PDF_ACTIVE_CONTENT: 'verification.quality.pdfUnsafe',
    PDF_ENCRYPTED: 'verification.quality.pdfEncrypted',
    IMAGE_DIMENSIONS_INVALID: 'verification.quality.tooSmall',
    POLYGLOT_FILE: 'verification.quality.wrongFormat',
  };

  return NextResponse.json(
    { error: key[reason], kind, max: MAX_UPLOAD_BYTES / (1024 * 1024) },
    { status: 400 },
  );
}
