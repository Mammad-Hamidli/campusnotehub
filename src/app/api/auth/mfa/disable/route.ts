import type { NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import { removeMfa } from '@/lib/firebase/repositories/mfa';
import { revokeOtherUserSessions } from '@/lib/firebase/repositories/sessions';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sendEmailAsync } from '@/lib/email/send';
import { mfaJson, mfaSession, stepUp } from '@/lib/auth/mfa-http';
import { secondFactorSchema } from '@/server/validators/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mfa/disable - { code } or { recoveryCode }.
 *
 * Staff cannot switch 2FA off: it is a condition of holding the role, and the
 * refusal comes BEFORE the step-up so it costs no attempt. (A staff member who
 * lost their authenticator is reset by an administrator instead - see
 * /api/admin/users/[userId]/mfa.) Everyone else can, with a fresh factor.
 *
 * Other sessions are revoked: switching protection off is a moment where an
 * intruder's session, if there is one, must not ride along.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  if (session.accountRole === UserRole.ADMIN || session.accountRole === UserRole.MODERATOR) {
    return mfaJson({ error: 'auth.errors.mfaRequiredForStaff' }, 403);
  }

  const parsed = secondFactorSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const proof = await stepUp(request, session, parsed.data);
  if (proof instanceof Response) return proof;

  await removeMfa(session.userId);
  const revoked = await revokeOtherUserSessions(session.userId, session.sessionId);

  const user = await findUserById(session.userId);
  if (user) sendEmailAsync(user.email, 'mfaDisabled', { nickname: user.nickname, byAdmin: false });

  await writeAuditLog({
    actorId: session.userId,
    action: 'MFA_DISABLED',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { otherSessionsRevoked: revoked },
  });

  return mfaJson({ ok: true });
}
