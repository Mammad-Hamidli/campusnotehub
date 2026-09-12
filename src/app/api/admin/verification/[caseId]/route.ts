import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus, UserRole } from '@/lib/enums';
import { z } from 'zod';
import { findCaseById, updateCase } from '@/lib/firebase/repositories/verification';
import { findUserById, updateUser } from '@/lib/firebase/repositories/users';
import { findUniversityById } from '@/lib/firebase/repositories/reference';
import { listUserDevices, revokeUserSessions } from '@/lib/firebase/repositories/sessions';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { writeModerationAction } from '@/lib/firebase/repositories/moderation';
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
 * GET /api/admin/verification/:caseId
 *
 * Returns the buffered document images as base64 for the review UI.
 *
 * The images are authenticated Cloudinary assets: this handler fetches them
 * server-side through signed URLs, so no deliverable Cloudinary URL ever
 * reaches the browser - see src/lib/verification/reviewBuffer.ts.
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

  const kase = await findCaseById(caseId);

  if (!kase || kase.status !== VerificationStatus.NEEDS_REVIEW || !kase.reviewBufferKey) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // The applicant, their institution and their devices: three reads where
  // Prisma had a nested include. Fetched only after the case has been
  // confirmed reviewable, so a 404 costs one read rather than four.
  const applicant = await findUserById(kase.userId);
  if (!applicant) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const [university, devices] = await Promise.all([
    applicant.universityId ? findUniversityById(applicant.universityId) : Promise.resolve(null),
    listUserDevices(applicant.id),
  ]);

  const documents = await retrieve({
    key: kase.reviewBufferKey,
    expiresAt: kase.reviewExpiresAt,
    documents: kase.reviewDocuments,
  });
  if (!documents) {
    // Normal outcome once the TTL lapses - not an error condition.
    return NextResponse.json(
      { error: 'admin.review.bufferExpired', expired: true },
      { status: 410 },
    );
  }

  // Written BEFORE the response so a crash mid-stream still leaves the access
  // recorded. An audit row that only appears on success is not an audit row.
  await writeAuditLog({
    actorId: moderatorId,
    action: 'KYC_DOCUMENTS_VIEWED',
    entityType: 'verification_case',
    entityId: caseId,
    after: { documentCount: documents.length },
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
          id: applicant.id,
          fullName: applicant.fullName,
          memberSince: applicant.createdAt,
          university: university ? { code: university.code, nameEn: university.nameEn } : null,
          devices: devices.map((d) => ({
            fingerprint: d.fingerprint,
            label: d.label,
            firstSeenAt: d.firstSeenAt,
          })),
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

  const kase = await findCaseById(caseId);

  if (!kase || kase.status !== VerificationStatus.NEEDS_REVIEW) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // Needed to address the outcome email and to record what the role was before
  // this decision changed it.
  const applicant = await findUserById(kase.userId);
  if (!applicant) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // Destroy the documents FIRST, before writing the decision.
  //
  // Ordering matters and is counter-intuitive: if the decision write then
  // fails, the resulting state is "documents gone, case still open" - the user
  // resubmits, which is annoying but safe. The reverse ordering would risk
  // "decision recorded, documents still sitting in the buffer", which is a
  // retention violation that nothing would ever clean up.
  //
  // This ordering matters MORE than it used to. Redis expired the blob on its
  // own, so a missed destroy() eventually corrected itself; Cloud Storage has
  // no per-object TTL, so this call and the scheduled sweep are the only two
  // things that remove it. See the header of reviewBuffer.ts.
  if (kase.reviewBufferKey) {
    await destroy(kase.reviewBufferKey);
  }

  const now = new Date();

  /**
   * ===========================================================================
   * NO LONGER ONE TRANSACTION - AND THE ORDER IS WHAT CARRIES THE SAFETY
   * ===========================================================================
   * These writes shared a Postgres transaction. They cannot share a Firestore
   * one for two independent reasons, and both are structural rather than
   * stylistic:
   *
   *   - applyBan() revokes every live session, which is an unbounded number of
   *     documents and chunks its own batches to stay under the 500-write cap;
   *   - a Firestore transaction cannot be passed across a module boundary the
   *     way a Prisma client could, so applyBan() and enqueueNotification()
   *     open their own.
   *
   * So the writes are sequenced deliberately: the moderation record first
   * (this decision was made, by this named person), then the case outcome,
   * then the account. A failure part-way leaves an over-documented decision
   * rather than an under-documented one - the log always says at least as much
   * as actually happened, never less.
   */
  await writeModerationAction({
    moderatorId,
    targetType: 'verification_case',
    targetId: caseId,
    action: decision.toLowerCase(),
    reason,
    metadata: { codes },
  });

  if (decision === 'APPROVE') {
    await updateCase(caseId, {
      status: VerificationStatus.VERIFIED,
      decidedAt: now,
      decidedByModeratorId: moderatorId,
      moderatorNote: reason,
      reviewBufferKey: null,
      reviewExpiresAt: null,
      reviewDocuments: null,
      publicMessageKey: 'verification.badge.verified',
    });

    await updateUser(kase.userId, {
      verificationStatus: VerificationStatus.VERIFIED,
      isVerified: true,
      verifiedAt: now,
      studentStatusConfirmed: true,
      identityConfirmed: true,
      // Only written when the moderator actually chose one - see the note on
      // the schema for why there is no default.
      ...(role ? { role } : {}),
    });

    /**
     * A grant that crosses the staff boundary revokes the account's live
     * sessions, so the new privilege level is picked up from a freshly minted
     * token rather than by a tab that is still carrying the old one. This
     * mirrors the role handler in /api/admin/users/:userId; the two must
     * behave the same or the guarantee depends on which screen was used.
     */
    if (role && PRIVILEGED_ROLES.has(role) !== PRIVILEGED_ROLES.has(applicant.role)) {
      await revokeUserSessions(kase.userId);
    }

    if (role && role !== applicant.role) {
      await writeAuditLog({
        actorId: moderatorId,
        action: 'ADMIN_USER_ROLE_CHANGED',
        entityType: 'user',
        entityId: kase.userId,
        before: { role: applicant.role },
        after: { role, viaCaseId: caseId, privileged: PRIVILEGED_ROLES.has(role) },
        result: 'SUCCESS',
        userAgent: request.headers.get('user-agent')?.slice(0, 512),
      });
    }

    await enqueueNotification({ skipEmail: true,
      userId: kase.userId,
      type: 'VERIFICATION_APPROVED',
      titleKey: 'notifications.types.VERIFICATION_APPROVED',
      bodyKey: 'verification.submitted.body',
      linkUrl: '/dashboard',
    });
  } else if (decision === 'REJECT') {
    // Not fraud - a bad submission. The user may try again.
    await updateCase(caseId, {
      status: VerificationStatus.REJECTED,
      decidedAt: now,
      decidedByModeratorId: moderatorId,
      moderatorNote: reason,
      failureCodes: codes,
      reviewBufferKey: null,
      reviewExpiresAt: null,
      reviewDocuments: null,
      publicMessageKey: 'verification.banner.rejected',
    });

    await updateUser(kase.userId, { verificationStatus: VerificationStatus.UNVERIFIED });

    await enqueueNotification({ skipEmail: true,
      userId: kase.userId,
      type: 'VERIFICATION_REJECTED',
      titleKey: 'notifications.types.VERIFICATION_REJECTED',
      bodyKey: 'verification.banner.rejected',
      linkUrl: '/verify',
    });
  } else {
    // BAN - confirmed fraud, decided by a named human.
    await updateCase(caseId, {
      status: VerificationStatus.BANNED,
      decidedAt: now,
      decidedByModeratorId: moderatorId,
      moderatorNote: reason,
      failureCodes: codes,
      reviewBufferKey: null,
      reviewExpiresAt: null,
      reviewDocuments: null,
      publicMessageKey: 'verification.failure.generic',
    });

    await applyBan({
      userId: kase.userId,
      moderatorId,
      reason,
      sourceCaseId: caseId,
    });

    await writeAuditLog({
      actorId: moderatorId,
      action: 'USER_BANNED_FRAUD',
      entityType: 'user',
      entityId: kase.userId,
      after: { caseId, codes, reason },
    });
  }

  /**
   * Outcome emails, sent only after every write above has landed.
   *
   * A BAN deliberately sends nothing from here. Ban notices are a legal
   * communication with an appeal path attached, and the generic "we could not
   * verify you" template would be actively misleading about what happened and
   * what the person can do next. The in-app record and the audit row carry the
   * decision; the notification belongs to the ban flow, not to this one.
   *
   * The rejection email names no fraud signal - see the note in templates.ts.
   */
  // Keyed on the case: a double-submitted decision must not mail twice.
  if (decision === 'APPROVE') {
    sendEmailAsync(
      applicant.email,
      'verificationApproved',
      { nickname: applicant.nickname },
      { dedupeKey: `verification-decision:${caseId}` },
    );
    if (role && role !== applicant.role) {
      sendEmailAsync(
        applicant.email,
        'roleAssigned',
        { nickname: applicant.nickname, role },
        { dedupeKey: `verification-role:${caseId}` },
      );
    }
  } else if (decision === 'REJECT') {
    sendEmailAsync(
      applicant.email,
      'verificationRejected',
      {
        nickname: applicant.nickname,
        // Deliberately null: `reason` is the MODERATOR's internal note and may
        // quote what they saw on the document. It belongs in the audit trail,
        // not in an email.
        reason: null,
        canResubmit: kase.attempt < Number(process.env.VERIFICATION_MAX_ATTEMPTS ?? 3),
      },
      { dedupeKey: `verification-decision:${caseId}` },
    );
  } else {
    // BAN. The moderator reason stays out of the email for the same reason as
    // above: it may quote the document. It is in the audit trail.
    sendEmailAsync(
      applicant.email,
      'accountSuspended',
      { nickname: applicant.nickname, level: 'banned', reason: null },
      { dedupeKey: `verification-ban:${caseId}` },
    );
  }

  return NextResponse.json({ ok: true, decision, role: role ?? null }, { status: 200 });
}
