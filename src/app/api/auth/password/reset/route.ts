import type { NextRequest } from 'next/server';
import { resetPasswordSchema } from '@/server/validators/auth';
import { isPasswordResetLive, redeemPasswordReset } from '@/lib/firebase/repositories/passwordResets';
import { revokeUserSessions } from '@/lib/firebase/repositories/sessions';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { hashPassword } from '@/lib/crypto/hash';
import { sendEmailAsync } from '@/lib/email/send';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { mfaJson } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INVALID = { error: 'auth.password.errors.linkInvalid' } as const;

/**
 * POST /api/auth/password/reset - { token, password }
 *
 * Order matters, and each step is there to keep the expensive or irreversible
 * part behind the cheap checks:
 *
 *   1. per-address limit       - before anything is parsed
 *   2. shape + password rule   - zod, no I/O
 *   3. token looks live        - one document read, so garbage tokens never
 *                                cost an argon2id hash
 *   4. hash the new password   - argon2id, outside any transaction
 *   5. redeem                  - ONE transaction: token re-checked, deleted,
 *                                new hash written, lockout cleared. Two
 *                                submissions of the same link cannot both win.
 *   6. revoke EVERY session    - whoever else was signed in is out. Access
 *                                tokens are checked against the session row on
 *                                each request, so this takes effect at once.
 *
 * No session is issued. The person signs in with the new password, which also
 * puts an enrolled account through its second factor - a reset replaces the
 * password, never the authenticator.
 *
 * Every token failure is the same 400: expired, used, superseded, account gone
 * all mean "request a new link" to the person holding it.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);

  const limit = await rateLimit('auth:password-reset:redeem', { ip });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  const parsed = resetPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const onPassword = parsed.error.issues.find((issue) => issue.path[0] === 'password');
    return mfaJson(onPassword ? { error: 'auth.errors.weakPassword', field: 'password' } : INVALID, 400);
  }
  const { token, password } = parsed.data;

  if (!(await isPasswordResetLive(token))) return mfaJson(INVALID, 400);

  const result = await redeemPasswordReset(token, await hashPassword(password));
  const userAgent = request.headers.get('user-agent')?.slice(0, 512);

  if (!result.ok) {
    await writeAuditLog({ action: 'PASSWORD_RESET', entityType: 'user', userAgent, result: 'DENIED' });
    return mfaJson(INVALID, 400);
  }

  const revoked = await revokeUserSessions(result.userId);
  await writeAuditLog({
    actorId: result.userId,
    action: 'PASSWORD_RESET',
    entityType: 'user',
    entityId: result.userId,
    userAgent,
    result: 'SUCCESS',
    after: { sessionsRevoked: revoked },
  });

  const user = await findUserById(result.userId);
  if (user) sendEmailAsync(user.email, 'passwordChanged', { nickname: user.nickname, viaReset: true });

  return mfaJson({ ok: true });
}
