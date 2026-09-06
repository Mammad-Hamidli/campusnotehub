import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminDismissCaseSchema } from '@/server/validators/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/verification/cases/:caseId/dismiss
 *
 * ---------------------------------------------------------------------------
 * "REMOVE FROM MY VIEW" IS NOT "DELETE FROM THE DATABASE"
 * ---------------------------------------------------------------------------
 * This endpoint exists so a moderator can clear rows they have already dealt
 * with out of a crowded queue. It is worth being explicit about what it does
 * NOT do, because the two are easy to conflate and only one of them is
 * recoverable:
 *
 *   - it does NOT delete the verification case;
 *   - it does NOT delete, ban, or otherwise touch the user's account;
 *   - it does NOT change the case's status, verdict, confidence or moderator;
 *   - it does NOT destroy the audit trail.
 *
 * It writes one timestamp, and the list query filters on it. Passing
 * `dismissed: false` clears the timestamp and the row returns. Anyone can see
 * the hidden rows by asking for `includeDismissed=true`.
 *
 * Permanent deletion of a user account is a different action entirely, lives
 * at DELETE /api/admin/users/:userId, is ADMIN-only, requires the operator to
 * type the target's nickname, and is still a soft delete. Nothing in this file
 * is a step toward it.
 *
 * ---------------------------------------------------------------------------
 * WHY AN UNDECIDED CASE CANNOT BE DISMISSED
 * ---------------------------------------------------------------------------
 * The guard below refuses to hide a case that is still awaiting a decision.
 * Without it, "tidy up the queue" becomes a way to make a pending applicant
 * silently disappear - nobody is told, no decision is recorded, and the
 * student waits forever on a review that will never be scheduled. A queue that
 * can lose people is worse than a crowded one.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const { caseId } = await params;

    const parsed = adminDismissCaseSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    }
    const { dismissed } = parsed.data;

    const kase = await db.verificationCase.findUnique({
      where: { id: caseId },
      select: { id: true, status: true, dismissedAt: true, decidedAt: true, userId: true },
    });
    if (!kase) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

    /**
     * "Dealt with" means decided, or no longer actionable.
     *
     * PROCESSING and NEEDS_REVIEW are the two states where a human still owes
     * the applicant an answer. A NEEDS_REVIEW case whose buffer has expired is
     * the exception: its documents are gone, so no decision can be made from
     * it and it is genuinely stale queue clutter - but the reaper turns those
     * into REJECTED anyway, so this simply refuses the live ones.
     */
    if (dismissed) {
      const undecided =
        kase.status === VerificationStatus.PROCESSING ||
        (kase.status === VerificationStatus.NEEDS_REVIEW && kase.decidedAt === null);

      if (undecided) {
        await adminAudit({
          actorId: actor.id,
          action: 'ADMIN_CASE_DISMISS_REFUSED',
          entityType: 'verification_case',
          entityId: caseId,
          after: { status: kase.status, reason: 'case still awaiting a decision' },
          result: 'DENIED',
          request,
        });
        return NextResponse.json(
          { error: 'admin.verifications.errors.undecided' },
          { status: 409 },
        );
      }
    }

    const dismissedAt = dismissed ? new Date() : null;

    await db.$transaction(async (tx) => {
      await tx.verificationCase.update({
        where: { id: caseId },
        data: { dismissedAt, dismissedById: dismissed ? actor.id : null },
      });

      await adminAudit({
        tx,
        actorId: actor.id,
        action: dismissed ? 'ADMIN_CASE_DISMISSED' : 'ADMIN_CASE_RESTORED',
        entityType: 'verification_case',
        entityId: caseId,
        before: { dismissedAt: kase.dismissedAt?.toISOString() ?? null },
        // Recorded explicitly so a later reader of the audit log can tell at a
        // glance that this action moved nothing but a view filter.
        after: {
          dismissedAt: dismissedAt?.toISOString() ?? null,
          note: 'queue view only; case, decision and account unchanged',
        },
        request,
      });
    });

    return NextResponse.json(
      { ok: true, caseId, dismissedAt: dismissedAt?.toISOString() ?? null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
