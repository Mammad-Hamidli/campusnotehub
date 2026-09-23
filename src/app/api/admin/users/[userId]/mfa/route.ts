import { NextResponse, type NextRequest } from 'next/server';
import { findUserById } from '@/lib/firebase/repositories/users';
import { getMfa, isEnrolled, removeMfa } from '@/lib/firebase/repositories/mfa';
import { revokeUserSessions } from '@/lib/firebase/repositories/sessions';
import { writeModerationAction } from '@/lib/firebase/repositories/moderation';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { requireSession } from '@/lib/auth/session';
import { stepUp } from '@/lib/auth/mfa-http';
import { sendEmailAsync } from '@/lib/email/send';
import { adminMfaResetSchema } from '@/server/validators/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/admin/users/[userId]/mfa - { reason, code | recoveryCode }.
 *
 * The support path for someone who lost BOTH their authenticator and their
 * recovery codes. ADMIN only, never MODERATOR: it removes a security control
 * from another person's account.
 *
 * Safeguards, each for a specific failure:
 *  - The admin re-proves their OWN second factor in this request. A stolen
 *    admin session (already past login MFA) is exactly what would be used to
 *    strip 2FA from other accounts; this makes that need the admin's phone.
 *  - Never on the admin's own account: that would let one factor disable
 *    itself. Their own reset goes through another administrator.
 *  - Every session of the target is revoked, so whoever may be holding one
 *    does not keep it through the reset.
 *  - The target is emailed, and a moderation action plus an audit row record
 *    who did it and why - identity must be checked OUT OF BAND first (the
 *    KYC data on file), and the reason field is where that is written down.
 *
 * The target's next sign-in is password-only; a staff target is then sent
 * straight to enrollment by the MFA gate in requireSession.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const { userId } = await params;
    const noStore = { 'Cache-Control': 'no-store, max-age=0' };

    const parsed = adminMfaResetSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400, headers: noStore },
      );
    }
    if (userId === actor.id) {
      return NextResponse.json({ error: 'auth.errors.mfaResetSelf' }, { status: 403, headers: noStore });
    }

    const target = await findUserById(userId);
    if (!target) return NextResponse.json({ error: 'errors.notFound' }, { status: 404, headers: noStore });
    // Checked before the step-up so a pointless reset costs the admin no attempt.
    if (!isEnrolled(await getMfa(userId))) {
      return NextResponse.json({ error: 'auth.errors.mfaNotEnrolled' }, { status: 409, headers: noStore });
    }

    const { sessionId } = await requireSession(request);
    const { code, recoveryCode } = parsed.data;
    const proof = await stepUp(request, { userId: actor.id, sessionId }, recoveryCode ? { recoveryCode } : { code });
    if (proof instanceof Response) return proof;

    await removeMfa(userId);
    const revoked = await revokeUserSessions(userId);

    await writeModerationAction({
      moderatorId: actor.id,
      targetType: 'user',
      targetId: userId,
      action: 'mfa:reset',
      reason: parsed.data.reason,
      metadata: { revoked },
    });
    await adminAudit({
      actorId: actor.id,
      action: 'ADMIN_MFA_RESET',
      entityType: 'user',
      entityId: userId,
      after: { revoked, reason: parsed.data.reason, targetRole: target.role },
      request,
    });
    sendEmailAsync(target.email, 'mfaDisabled', { nickname: target.nickname, byAdmin: true });

    return NextResponse.json({ ok: true, revoked }, { headers: noStore });
  });
}
