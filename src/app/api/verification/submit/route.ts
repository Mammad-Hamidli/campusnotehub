import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus } from '@/lib/enums';
import { findUserById } from '@/lib/firebase/repositories/users';
import { newCaseId, listCases } from '@/lib/firebase/repositories/verification';
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
import type { BufferedDocument } from '@/lib/verification/reviewBuffer';
import { enqueueSubmission } from '@/lib/verification/aiQueue';
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
 * HOW LONG A DOCUMENT CAN EXIST, AND WHY IT IS BOUNDED
 * ---------------------------------------------------------------------------
 * An early design uploaded documents to S3 with a presigned POST and purged
 * them 30 days later - a retention policy with no hard ceiling (versioning
 * keeps deleted objects recoverable, and a backed-up queue holds documents for
 * as long as it is backed up). Documents still wait in a queue today, but the
 * ceiling is structural: Cloudinary assets under the review-buffer prefix are
 * deleted 7 days after upload by three independent mechanisms, whatever the
 * state of the queue or of the case row.
 *
 * The request validates the bytes in memory under a hard cap and then parks
 * them in the 7-day authenticated Cloudinary review buffer, with the case
 * NEEDS_REVIEW ("under review") and queued for the nightly AI check - see
 * src/lib/verification/aiQueue.ts. That batch reads the documents with
 * Cloudflare's vision model in FIFO order, approves a complete match and
 * destroys the images, and leaves anything else to a moderator, who can also
 * decide a queued case before the batch reaches it. The buffer's 7-day cap
 * (src/lib/verification/reviewBuffer.ts) bounds how long any image can wait.
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
  const documents: BufferedDocument[] = [];

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

    // ---- Queue for the nightly check -------------------------------------
    let caseId: string;
    try {
      caseId = (
        await enqueueSubmission({ userId, caseId: newCaseId(), attempt: priorAttempts + 1, documents })
      ).id;
    } catch (error) {
      // Nothing was queued (enqueueSubmission removes a half-made buffer), so
      // the account is left as it was and no attempt is spent.
      console.error('[verification] submission could not be queued', error);
      return NextResponse.json({ error: 'errors.generic' }, { status: 503 });
    }

    /**
     * "We have your documents" - every accepted submission is now queued, so
     * this is the only thing the user hears until the nightly check decides.
     *
     * The message says the submission was received and how the documents are
     * held, and deliberately does NOT state a verdict: an approval or a
     * rejection gets its own email from the decision path.
     */
    sendEmailAsync(user.email, 'verificationSubmitted', { nickname: user.nickname });

    return NextResponse.json(
      {
        caseId,
        status: VerificationStatus.NEEDS_REVIEW,
        attempt: priorAttempts + 1,
        remainingAttempts: Math.max(0, MAX_ATTEMPTS - (priorAttempts + 1)),
        messageKey: 'verification.banner.needsReview',
      },
      { status: 200 },
    );
  } finally {
    // Every path ends here: queued (the buffer holds the only copy now),
    // rejected by validation, or failed. No in-memory copy outlives the request.
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
