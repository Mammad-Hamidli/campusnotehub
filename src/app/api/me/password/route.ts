import type { NextRequest } from 'next/server';
import { changePasswordSchema } from '@/server/validators/auth';
import { findUserById, getCredentials, updateCredentials } from '@/lib/firebase/repositories/users';
import { revokeOtherUserSessions } from '@/lib/firebase/repositories/sessions';
import { revokePasswordResets } from '@/lib/firebase/repositories/passwordResets';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { hashPassword, verifyPassword } from '@/lib/crypto/hash';
import { sendEmailAsync } from '@/lib/email/send';
import { clientIp, peekRateLimit, rateLimit } from '@/lib/security/ratelimit';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/me/password - whether the account has a password to change. */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;
  const credential = await getCredentials(session.userId);
  return mfaJson({ hasPassword: typeof credential?.passwordHash === 'string' });
}

/**
 * POST /api/me/password - { currentPassword, newPassword }
 *
 * The CURRENT password is required even though the caller holds a session: a
 * session can be borrowed (an unlocked laptop, a stolen cookie), and a
 * password change is what turns a borrowed session into a stolen account.
 * Wrong guesses are charged to `auth:reauth`, the same budget every other
 * "confirm it is you" prompt spends, so this cannot become a side door for
 * guessing.
 *
 * On success every OTHER session is revoked - this one stays, since it just
 * proved the password - and every outstanding reset link dies, so an old
 * link in the inbox cannot undo the change.
 *
 * Failures answer 400/403, never 401: on a signed-in route 401 means "session
 * gone" to the SessionKeeper.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const ip = clientIp(request.headers);
  const identity = { userId: session.userId, ip };

  const budget = await rateLimit('auth:password-change', identity);
  if (!budget.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const parsed = changePasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // Only the new password carries message keys worth showing (too weak,
    // same as the current one); anything else is a malformed body.
    const issue = parsed.error.issues.find((i) => i.path[0] === 'newPassword' && i.message.startsWith('auth.'));
    return mfaJson(issue ? { error: issue.message, field: 'newPassword' } : { error: 'errors.validationFailed' }, 400);
  }
  const { currentPassword, newPassword } = parsed.data;

  const credential = await getCredentials(session.userId);
  if (typeof credential?.passwordHash !== 'string') {
    return mfaJson({ error: 'auth.password.errors.noPassword' }, 409);
  }

  const reauth = await peekRateLimit('auth:reauth', identity);
  if (!reauth.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(reauth.retryAfterSeconds) });
  }
  const check = await verifyPassword(currentPassword, credential.passwordHash);
  const userAgent = request.headers.get('user-agent')?.slice(0, 512);
  if (!check.valid) {
    await rateLimit('auth:reauth', identity);
    await writeAuditLog({
      actorId: session.userId,
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: session.userId,
      userAgent,
      result: 'DENIED',
    });
    return mfaJson({ error: 'auth.errors.reauthFailed', field: 'currentPassword' }, 403);
  }

  await updateCredentials(session.userId, { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() });
  const [revoked] = await Promise.all([
    revokeOtherUserSessions(session.userId, session.sessionId),
    revokePasswordResets(session.userId),
  ]);

  await writeAuditLog({
    actorId: session.userId,
    action: 'PASSWORD_CHANGE',
    entityType: 'user',
    entityId: session.userId,
    userAgent,
    result: 'SUCCESS',
    after: { sessionsRevoked: revoked },
  });

  const user = await findUserById(session.userId);
  if (user) sendEmailAsync(user.email, 'passwordChanged', { nickname: user.nickname });

  return mfaJson({ ok: true, sessionsRevoked: revoked });
}
