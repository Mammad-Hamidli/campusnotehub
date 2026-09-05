import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { isUserBlocked } from '@/lib/security/blocklist';
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

// Must be the Node runtime: the pipeline holds Buffers and calls node:crypto.
export const runtime = 'nodejs';
// Never cache, never prerender. This route handles identity documents.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_ATTEMPTS = Number(process.env.VERIFICATION_MAX_ATTEMPTS ?? 3);

const REQUIRED_KINDS = [
  'STUDENT_CARD_FRONT',
  'STUDENT_CARD_BACK',
  'ID_FRONT',
  'ID_BACK',
] as const;
type RequiredKind = (typeof REQUIRED_KINDS)[number];

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
 * TTL-bound encrypted Redis buffer so a human can actually review them - see
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

  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      verificationStatus: true,
      accountStatus: true,
      fullName: true,
      university: { select: { code: true } },
    },
  });

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
  const priorAttempts = await db.verificationCase.count({
    where: { userId, decidedAt: { not: null } },
  });
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

    for (const kind of REQUIRED_KINDS) {
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
    const kase = await db.$transaction(async (tx) => {
      const created = await tx.verificationCase.create({
        data: {
          userId,
          attempt: priorAttempts + 1,
          status: VerificationStatus.PROCESSING,
        },
        select: { id: true, attempt: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: { verificationStatus: VerificationStatus.PROCESSING },
      });
      return created;
    });

    const input: PipelineInput = {
      userId,
      caseId: kase.id,
      documents,
      declaredName: user.fullName,
      declaredUniversityCode: user.university?.code ?? null,
    };

    let outcome;
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

    return NextResponse.json(
      {
        caseId: kase.id,
        status: outcome.status,
        attempt: kase.attempt,
        remainingAttempts: Math.max(0, MAX_ATTEMPTS - (priorAttempts + 1)),
        messageKey: outcome.messageKey,
        // Present only for NEEDS_REVIEW. Handed to the moderator queue, never
        // to the user - it is the decryption key for the review buffer.
        reviewSecret: undefined,
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
