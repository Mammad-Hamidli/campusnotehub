import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus, UserRole } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth/session';
import { retrieve, destroy } from '@/lib/verification/reviewBuffer';
import { applyBan } from '@/lib/security/blocklist';
import { sendEmailAsync } from '@/lib/email/send';
import { ASSIGNABLE_ROLES, PRIVILEGED_ROLES } from '@/server/validators/admin';
import { enqueueNotification } from '@/lib/notifications/dispatch';
import { wipe } from '@/lib/verification/fileValidation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Moderator review endpoints.
 *
 * GET  streams the buffered documents for one flagged case
 * POST records the human decision (approve / reject / ban)
 *
 * Every response here carries no-store and every access writes an audit row.
 * Viewing someone's national ID is the most sensitive action any staff member
 * can take on this platform, and it must never be possible to do it silently.
 */

async function requireModerator(request: NextRequest) {
  const { userId, viewer } = await requireSession(request);
  if (viewer.role !== UserRole.MODERATOR && viewer.role !== UserRole.ADMIN) {
    throw new ForbiddenError();
  }
  return userId;
}

class ForbiddenError extends Error {
  readonly status = 403;
}

/**
 * GET /api/admin/verification/:caseId?secret=...
 *
 * Returns the buffered document images as base64 for the review UI.
 *
 * The `secret` is the per-case decryption key produced when the buffer was
 * stashed. It is NOT stored in Postgres - it lives only in the moderator queue
 * entry. That means a database compromise alone does not let an attacker read
 * pending review documents out of Redis, and it means we can hand out review
 * access per-case rather than granting blanket decrypt rights.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  let moderatorId: string;
  try {
    moderatorId = await requireModerator(request);
  } catch {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  const { caseId } = await params;
  /**
   * Optional now. The buffer key is derived server-side from the application
   * secret (see deriveKey in reviewBuffer.ts), so a moderator does not have to
   * carry one. This used to hard-fail with a 400 whenever the parameter was
   * absent - which was always, because nothing ever produced a secret to send,
   * and it is why the review panel never displayed a single document.
   *
   * An explicitly supplied secret is still honoured, so an out-of-band key
   * distribution can be layered back on without touching this handler.
   */
  const secret = request.nextUrl.searchParams.get('secret') ?? undefined;

  const kase = await db.verificationCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      status: true,
      reviewBufferKey: true,
      reviewExpiresAt: true,
      confidence: true,
      failureCodes: true,
      checkScores: true,
      user: {
        select: {
          id: true,
          fullName: true,
          createdAt: true,
          university: { select: { code: true, nameEn: true } },
          devices: { select: { fingerprint: true, label: true, firstSeenAt: true } },
        },
      },
    },
  });

  if (!kase || kase.status !== VerificationStatus.NEEDS_REVIEW || !kase.reviewBufferKey) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const documents = await retrieve(kase.reviewBufferKey, secret);
  if (!documents) {
    // Normal outcome once the TTL lapses - not an error condition.
    return NextResponse.json(
      { error: 'admin.review.bufferExpired', expired: true },
      { status: 410 },
    );
  }

  // Written BEFORE the response so a crash mid-stream still leaves the access
  // recorded. An audit row that only appears on success is not an audit row.
  await db.auditLog.create({
    data: {
      actorId: moderatorId,
      action: 'KYC_DOCUMENTS_VIEWED',
      entityType: 'verification_case',
      entityId: caseId,
      after: { documentCount: documents.length },
    },
  });

  try {
    return NextResponse.json(
      {
        case: {
          id: kase.id,
          confidence: kase.confidence,
          failureCodes: kase.failureCodes,
          checkScores: kase.checkScores,
          expiresAt: kase.reviewExpiresAt,
        },
        applicant: {
          id: kase.user.id,
          fullName: kase.user.fullName,
          memberSince: kase.user.createdAt,
          university: kase.user.university,
          devices: kase.user.devices,
        },
        documents: documents.map((doc) => ({
          kind: doc.kind,
          mime: doc.mime,
          dataUrl: `data:${doc.mime};base64,${doc.bytes.toString('base64')}`,
        })),
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, private',
          'Content-Security-Policy': "default-src 'none'; img-src data:",
        },
      },
    );
  } finally {
    for (const doc of documents) wipe(doc.bytes);
  }
}

const decisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT', 'BAN']),
    /** Required for REJECT and BAN. Stored, shown in the audit trail. */
    reason: z.string().trim().min(10).max(2000),
    /** Machine-readable, for model retraining. Codes only, never quoted text. */
    codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)).max(10).default([]),
    /**
     * The role to grant on APPROVE.
     *
     * Optional, and its absence means "leave the role as it is" rather than
     * "make them a student". Defaulting would be worse than asking: the
     * approving moderator has the applicant's documents in front of them and
     * is the only party who can tell a lecturer from a first-year, so a silent
     * default would quietly assert STUDENT for every teacher on the platform
     * and the mistake would surface only when they could not offer mentoring.
     */
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    /**
     * Must be echoed true by the client when `role` is MODERATOR or ADMIN.
     *
     * The confirmation dialog is a UI affordance and a UI affordance is not a
     * control - a caller that skips the dialog must not thereby skip the
     * safeguard, so the server requires the acknowledgement explicitly.
     */
    confirmPrivileged: z.boolean().optional(),
  })
  .refine((d) => !d.role || !PRIVILEGED_ROLES.has(d.role) || d.confirmPrivileged === true, {
    path: ['confirmPrivileged'],
    message: 'admin.users.errors.confirmPrivilegedRequired',
  });

/**
 * POST /api/admin/verification/:caseId
 *
 * The human decision. This is the ONLY code path in the platform that can ban
 * an account for document fraud - `decide()` in the automated policy has no
 * BANNED outcome at all. See the comment there for the legal and statistical
 * reasoning.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  let moderatorId: string;
  try {
    moderatorId = await requireModerator(request);
  } catch {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  const { caseId } = await params;
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { decision, reason, codes, role } = parsed.data;

  const kase = await db.verificationCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      userId: true,
      status: true,
      reviewBufferKey: true,
      attempt: true,
      // Needed to address the outcome email and to record what the role was
      // before this decision changed it.
      user: { select: { email: true, nickname: true, role: true } },
    },
  });

  if (!kase || kase.status !== VerificationStatus.NEEDS_REVIEW) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // Destroy the documents FIRST, before writing the decision.
  //
  // Ordering matters and is counter-intuitive: if the database write then
  // fails, the resulting state is "documents gone, case still open" - the user
  // resubmits, which is annoying but safe. The reverse ordering would risk
  // "decision recorded, documents still sitting in Redis", which is a
  // retention violation that nothing would ever clean up.
  if (kase.reviewBufferKey) {
    await destroy(kase.reviewBufferKey);
  }

  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.moderationAction.create({
      data: {
        moderatorId,
        targetType: 'verification_case',
        targetId: caseId,
        action: decision.toLowerCase(),
        reason,
        metadata: { codes },
      },
    });

    if (decision === 'APPROVE') {
      await tx.verificationCase.update({
        where: { id: caseId },
        data: {
          status: VerificationStatus.VERIFIED,
          decidedAt: now,
          decidedByModeratorId: moderatorId,
          moderatorNote: reason,
          reviewBufferKey: null,
          reviewExpiresAt: null,
          publicMessageKey: 'verification.badge.verified',
        },
      });
      await tx.user.update({
        where: { id: kase.userId },
        data: {
          verificationStatus: VerificationStatus.VERIFIED,
          isVerified: true,
          verifiedAt: now,
          studentStatusConfirmed: true,
          identityConfirmed: true,
          // Only written when the moderator actually chose one - see the note
          // on the schema for why there is no default.
          ...(role ? { role } : {}),
        },
      });

      /**
       * A grant that crosses the staff boundary revokes the account's live
       * sessions, so the new privilege level is picked up from a freshly
       * minted token rather than by a tab that is still carrying the old one.
       * This mirrors the role handler in /api/admin/users/:userId; the two must
       * behave the same or the guarantee depends on which screen was used.
       */
      if (role && PRIVILEGED_ROLES.has(role) !== PRIVILEGED_ROLES.has(kase.user.role)) {
        await tx.session.updateMany({
          where: { userId: kase.userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      if (role && role !== kase.user.role) {
        await tx.auditLog.create({
          data: {
            actorId: moderatorId,
            action: 'ADMIN_USER_ROLE_CHANGED',
            entityType: 'user',
            entityId: kase.userId,
            before: { role: kase.user.role },
            after: { role, viaCaseId: caseId, privileged: PRIVILEGED_ROLES.has(role) },
            result: 'SUCCESS',
            userAgent: request.headers.get('user-agent')?.slice(0, 512),
          },
        });
      }
      await enqueueNotification(tx, {
        userId: kase.userId,
        type: 'VERIFICATION_APPROVED',
        titleKey: 'notifications.types.VERIFICATION_APPROVED',
        bodyKey: 'verification.submitted.body',
        linkUrl: '/dashboard',
      });
      return;
    }

    if (decision === 'REJECT') {
      // Not fraud - a bad submission. The user may try again.
      await tx.verificationCase.update({
        where: { id: caseId },
        data: {
          status: VerificationStatus.REJECTED,
          decidedAt: now,
          decidedByModeratorId: moderatorId,
          moderatorNote: reason,
          failureCodes: codes,
          reviewBufferKey: null,
          reviewExpiresAt: null,
          publicMessageKey: 'verification.banner.rejected',
        },
      });
      await tx.user.update({
        where: { id: kase.userId },
        data: { verificationStatus: VerificationStatus.UNVERIFIED },
      });
      await enqueueNotification(tx, {
        userId: kase.userId,
        type: 'VERIFICATION_REJECTED',
        titleKey: 'notifications.types.VERIFICATION_REJECTED',
        bodyKey: 'verification.banner.rejected',
        linkUrl: '/register',
      });
      return;
    }

    // BAN - confirmed fraud, decided by a named human.
    await tx.verificationCase.update({
      where: { id: caseId },
      data: {
        status: VerificationStatus.BANNED,
        decidedAt: now,
        decidedByModeratorId: moderatorId,
        moderatorNote: reason,
        failureCodes: codes,
        reviewBufferKey: null,
        reviewExpiresAt: null,
        publicMessageKey: 'verification.failure.generic',
      },
    });

    await applyBan({
      tx,
      userId: kase.userId,
      moderatorId,
      reason,
      sourceCaseId: caseId,
    });

    await tx.auditLog.create({
      data: {
        actorId: moderatorId,
        action: 'USER_BANNED_FRAUD',
        entityType: 'user',
        entityId: kase.userId,
        after: { caseId, codes, reason },
      },
    });
  });

  /**
   * Outcome emails, sent only after the transaction has committed.
   *
   * A BAN deliberately sends nothing from here. Ban notices are a legal
   * communication with an appeal path attached, and the generic "we could not
   * verify you" template would be actively misleading about what happened and
   * what the person can do next. The in-app record and the audit row carry the
   * decision; the notification belongs to the ban flow, not to this one.
   *
   * The rejection email names no fraud signal - see the note in templates.ts.
   */
  if (decision === 'APPROVE') {
    sendEmailAsync(kase.user.email, 'verificationApproved', { nickname: kase.user.nickname });
    if (role && role !== kase.user.role) {
      sendEmailAsync(kase.user.email, 'roleAssigned', { nickname: kase.user.nickname, role });
    }
  } else if (decision === 'REJECT') {
    sendEmailAsync(kase.user.email, 'verificationRejected', {
      nickname: kase.user.nickname,
      // Deliberately null: `reason` is the MODERATOR's internal note and may
      // quote what they saw on the document. It belongs in the audit trail,
      // not in an email.
      reason: null,
      canResubmit: kase.attempt < Number(process.env.VERIFICATION_MAX_ATTEMPTS ?? 3),
    });
  }

  return NextResponse.json({ ok: true, decision, role: role ?? null }, { status: 200 });
}
