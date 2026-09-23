import type { NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import { confirmEnrollment } from '@/lib/firebase/repositories/mfa';
import { markSessionMfa, revokeOtherUserSessions } from '@/lib/firebase/repositories/sessions';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sendEmailAsync } from '@/lib/email/send';
import { factorFailure, mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { mfaConfirmSchema } from '@/server/validators/auth';
import { clientIp, peekRateLimit, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mfa/totp/confirm - { code } from the newly scanned app.
 *
 * On success, in this order:
 *  1. The pending secret becomes the active one, with fresh recovery codes
 *     (atomic, in confirmEnrollment).
 *  2. THIS session is marked MFA-verified: the person just proved possession
 *     of the authenticator, so a staff member gets the panel back without
 *     signing out and in again.
 *  3. Every OTHER session is revoked. They were established without the new
 *     factor - if one of them belongs to whoever stole the password, turning
 *     2FA on must actually evict them, not merely protect future sign-ins.
 *  4. The owner is emailed, which is the only defence for a FIRST enrollment
 *     done by someone who already had the password (see /totp/setup).
 *
 * The recovery codes are in this response and nowhere else, ever.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const identity = { userId: session.userId, ip: clientIp(request.headers) };
  const budget = await peekRateLimit('auth:mfa', identity);
  if (!budget.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const parsed = mfaConfirmSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const result = await confirmEnrollment(session.userId, parsed.data.code);
  if (!result.ok) {
    if (result.reason === 'no_pending' || result.reason === 'expired') {
      return mfaJson({ error: 'auth.errors.mfaSetupExpired' }, 409);
    }
    if (result.reason === 'invalid') await rateLimit('auth:mfa', identity);
    return factorFailure({ ok: false, reason: result.reason });
  }

  await markSessionMfa(session.sessionId, 'otp', new Date());
  const revoked = await revokeOtherUserSessions(session.userId, session.sessionId);

  const user = await findUserById(session.userId);
  if (user) sendEmailAsync(user.email, 'mfaEnabled', { nickname: user.nickname, replaced: result.replaced });

  await writeAuditLog({
    actorId: session.userId,
    action: result.replaced ? 'MFA_REPLACED' : 'MFA_ENABLED',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { method: 'totp', otherSessionsRevoked: revoked },
  });

  const staff = session.accountRole === UserRole.ADMIN || session.accountRole === UserRole.MODERATOR;
  return mfaJson({ recoveryCodes: result.recoveryCodes, next: staff ? { href: '/admin' } : null });
}
