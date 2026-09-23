import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError, type SessionResult } from '@/lib/auth/session';
import { markSessionMfa } from '@/lib/firebase/repositories/sessions';
import {
  verifySecondFactor,
  type SecondFactorInput,
  type SecondFactorMethod,
  type SecondFactorResult,
} from '@/lib/firebase/repositories/mfa';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sendEmailAsync } from '@/lib/email/send';
import { clientIp, peekRateLimit, rateLimit } from '@/lib/security/ratelimit';

/**
 * Shared plumbing for the /api/auth/mfa/* routes and the admin reset.
 *
 * NO-STORE ON EVERYTHING. These responses carry TOTP secrets, QR codes,
 * recovery codes and login tickets. A shared cache, a browser back/forward
 * cache or a service worker holding one of them is a credential sitting on
 * disk, so every response built here says so.
 */
/**
 * Where a login ticket travels when the sign-in was a REDIRECT (a social
 * provider callback) rather than a fetch: an httpOnly cookie scoped to the MFA
 * routes, never the URL - a ticket in a query string ends up in history, logs
 * and Referer headers. Lax is enough: the verify call is same-site.
 */
export const MFA_TICKET_COOKIE = 'CH_MT';
export const MFA_TICKET_COOKIE_PATH = '/api/auth/mfa';

export function setMfaTicketCookie(response: NextResponse, token: string) {
  response.cookies.set(MFA_TICKET_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: MFA_TICKET_COOKIE_PATH,
    maxAge: 5 * 60,
  });
}

export function clearMfaTicketCookie(response: NextResponse) {
  response.cookies.set(MFA_TICKET_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: MFA_TICKET_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

export function mfaJson(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', ...headers },
  });
}

export async function mfaSession(request: NextRequest): Promise<SessionResult | NextResponse> {
  try {
    return await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return mfaJson({ error: 'errors.sessionExpired' }, 401);
    throw error;
  }
}

/**
 * Status codes for a refused second factor on a SIGNED-IN request.
 *
 * Never 401: that means "your session is gone" to the SessionKeeper, which
 * would refresh and replay the request - a wrong code would then cost two
 * attempts, or look like a logout. 400 is "this input was wrong".
 */
export function factorFailure(result: Exclude<SecondFactorResult, { ok: true }>, retryAfterSeconds = 900) {
  switch (result.reason) {
    case 'not_enrolled':
      return mfaJson({ error: 'auth.errors.mfaNotEnrolled' }, 409);
    case 'locked':
      return mfaJson({ error: 'auth.errors.mfaLocked' }, 429, { 'Retry-After': String(retryAfterSeconds) });
    default:
      return mfaJson({ error: 'auth.errors.mfaInvalid' }, 400);
  }
}

/** The email that must follow any sign-in or step-up that spent a recovery code. */
export async function notifyRecoveryCodeUsed(userId: string, remaining: number) {
  const user = await findUserById(userId);
  if (user) sendEmailAsync(user.email, 'mfaRecoveryCodeUsed', { nickname: user.nickname, remaining });
}

/**
 * Re-proves the second factor on the CURRENT session, before a sensitive
 * change (replacing the authenticator, new recovery codes, turning 2FA off,
 * an admin resetting someone else's).
 *
 * A fresh code is demanded per action rather than trusting "this session did
 * MFA at login": a session left open on a shared computer has already passed
 * MFA, and these actions are exactly what someone who walked up to it would
 * want to do to keep access.
 *
 * On success the session is also marked as MFA-verified, which is what lets a
 * staff session created before enrollment (or before this feature) recover
 * its privileges without signing out.
 */
export async function stepUp(
  request: NextRequest,
  session: Pick<SessionResult, 'userId' | 'sessionId'>,
  input: SecondFactorInput,
): Promise<{ ok: true; method: SecondFactorMethod } | NextResponse> {
  const identity = { userId: session.userId, ip: clientIp(request.headers) };
  const budget = await peekRateLimit('auth:mfa', identity);
  if (!budget.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const result = await verifySecondFactor(session.userId, input);
  if (!result.ok) {
    if (result.reason === 'invalid') await rateLimit('auth:mfa', identity);
    await writeAuditLog({
      actorId: session.userId,
      action: 'MFA_STEP_UP',
      entityType: 'user',
      entityId: session.userId,
      userAgent: request.headers.get('user-agent')?.slice(0, 512),
      result: 'FAILURE',
      after: { reason: result.reason },
    });
    return factorFailure(result);
  }

  await markSessionMfa(session.sessionId, result.method === 'totp' ? 'otp' : 'recovery', new Date());
  if (result.method === 'recovery') await notifyRecoveryCodeUsed(session.userId, result.recoveryCodesRemaining);
  return { ok: true, method: result.method };
}
