import type { NextRequest } from 'next/server';
import type { SessionResult } from '@/lib/auth/session';
import { getCredentials } from '@/lib/firebase/repositories/users';
import { getMfa, isEnrolled } from '@/lib/firebase/repositories/mfa';
import { verifyPassword } from '@/lib/crypto/hash';
import { clientIp, peekRateLimit, rateLimit } from '@/lib/security/ratelimit';
import { mfaJson, stepUp } from '@/lib/auth/mfa-http';

/**
 * "Prove it is still you" before a sensitive change: linking or unlinking a
 * sign-in method, requesting account deletion.
 *
 * The STRONGEST factor the account has is demanded, so a weaker one can never
 * be used to get around a stronger one:
 *
 *   2FA enrolled         -> an authenticator or recovery code (never just the
 *                           password: that is exactly what 2FA exists to back up)
 *   password, no 2FA     -> the password
 *   neither (social-only)-> a sign-in within the last ten minutes. The account
 *                           has nothing to re-enter; having just come back
 *                           through Google IS the proof, and
 *                           "sign out and in again" is the instruction.
 *
 * `authenticatedAt` survives refresh rotation (see SessionRecord.authAt), so
 * a long-lived session that merely refreshed does not count as recent.
 */
export const RECENT_SIGN_IN_MS = 10 * 60_000;

export type ReauthBody = { password?: string; code?: string; recoveryCode?: string };
export type ReauthMethod = 'totp' | 'recovery' | 'password' | 'recent_sign_in';

export async function reauthenticate(
  request: NextRequest,
  session: Pick<SessionResult, 'userId' | 'sessionId' | 'authenticatedAt'>,
  body: ReauthBody,
): Promise<{ ok: true; method: ReauthMethod } | Response> {
  const [mfa, credential] = await Promise.all([getMfa(session.userId), getCredentials(session.userId)]);

  if (isEnrolled(mfa)) {
    if (!body.code && !body.recoveryCode) return mfaJson({ error: 'auth.errors.reauthCodeRequired' }, 403);
    const proof = await stepUp(request, session, body.recoveryCode ? { recoveryCode: body.recoveryCode } : { code: body.code });
    return proof instanceof Response ? proof : { ok: true, method: proof.method };
  }

  if (typeof credential?.passwordHash === 'string') {
    if (!body.password) return mfaJson({ error: 'auth.errors.reauthPasswordRequired' }, 403);
    const identity = { userId: session.userId, ip: clientIp(request.headers) };
    const budget = await peekRateLimit('auth:reauth', identity);
    if (!budget.ok) {
      return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(budget.retryAfterSeconds) });
    }
    const check = await verifyPassword(body.password, credential.passwordHash);
    if (!check.valid) {
      await rateLimit('auth:reauth', identity);
      return mfaJson({ error: 'auth.errors.reauthFailed' }, 403);
    }
    return { ok: true, method: 'password' };
  }

  if (Date.now() - session.authenticatedAt.getTime() <= RECENT_SIGN_IN_MS) return { ok: true, method: 'recent_sign_in' };
  return mfaJson({ error: 'auth.errors.reauthRecentSignIn' }, 403);
}

/** Which proof the UI should ask for, without revealing more than the owner already knows. */
export async function reauthRequirement(userId: string): Promise<'code' | 'password' | 'recent_sign_in'> {
  const [mfa, credential] = await Promise.all([getMfa(userId), getCredentials(userId)]);
  if (isEnrolled(mfa)) return 'code';
  return typeof credential?.passwordHash === 'string' ? 'password' : 'recent_sign_in';
}
