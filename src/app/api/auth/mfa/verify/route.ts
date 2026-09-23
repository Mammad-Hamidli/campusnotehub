import type { NextRequest } from 'next/server';
import { redeemLoginTicket } from '@/lib/firebase/repositories/mfa';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { isUserBlocked } from '@/lib/security/blocklist';
import { clientIp, peekRateLimit, rateLimit } from '@/lib/security/ratelimit';
import { completeLogin } from '@/lib/auth/complete-login';
import { MFA_TICKET_COOKIE, clearMfaTicketCookie, mfaJson, notifyRecoveryCodeUsed } from '@/lib/auth/mfa-http';
import { mfaVerifySchema } from '@/server/validators/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mfa/verify - { ticket, code } or { ticket, recoveryCode }.
 *
 * The second half of signing in to an account with 2FA. The ticket came from
 * POST /api/auth/login after the password verified.
 *
 * Responses the client must tell apart:
 *   401 auth.errors.mfaInvalid        wrong code; same ticket, try again
 *   401 auth.errors.mfaTicketExpired  start over from the password
 *   429 auth.errors.mfaLocked         too many wrong codes on the account
 *
 * 401 is safe here (unlike on the signed-in MFA routes) because the
 * SessionKeeper never retries /api/auth/*, and there is no session to lose.
 *
 * ---------------------------------------------------------------------------
 * THE ACCOUNT IS RE-CHECKED AFTER THE SECOND FACTOR
 * ---------------------------------------------------------------------------
 * Up to five minutes pass between the password and the code. An account
 * banned, deleted or blocked in that window must not come out the other side
 * with a session just because its ticket was issued earlier, so the same
 * status checks the login route ran are run again on live data.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const ipBudget = await peekRateLimit('auth:mfa:ip', { ip });
  if (!ipBudget.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(ipBudget.retryAfterSeconds) });
  }

  const parsed = mfaVerifySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const { code, recoveryCode } = parsed.data;
  // Body for a password sign-in; cookie for a social one (see MFA_TICKET_COOKIE).
  const ticket = parsed.data.ticket ?? request.cookies.get(MFA_TICKET_COOKIE)?.value ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';
  const result = await redeemLoginTicket({
    token: ticket,
    userAgent,
    input: recoveryCode ? { recoveryCode } : { code },
  });

  if (!result.ok) {
    // A bad or expired ticket is charged too: cycling random tickets is also
    // a way to probe this endpoint.
    if (result.reason === 'invalid' || result.reason === 'ticket') await rateLimit('auth:mfa:ip', { ip });
    if (result.userId) {
      await writeAuditLog({
        actorId: result.userId,
        action: 'USER_LOGIN_MFA',
        entityType: 'user',
        entityId: result.userId,
        userAgent: userAgent.slice(0, 512),
        result: 'FAILURE',
        after: { reason: result.reason, method: recoveryCode ? 'recovery' : 'totp' },
      });
    }
    if (result.reason === 'locked') {
      return clearMfaTicketCookie(mfaJson({ error: 'auth.errors.mfaLocked' }, 429, { 'Retry-After': '900' }));
    }
    // A wrong code keeps the ticket (and its cookie) for another try.
    if (result.reason === 'invalid') return mfaJson({ error: 'auth.errors.mfaInvalid' }, 401);
    return clearMfaTicketCookie(mfaJson({ error: 'auth.errors.mfaTicketExpired' }, 401));
  }

  const user = await findUserById(result.userId);
  if (
    !user ||
    user.deletedAt ||
    user.accountStatus === 'BANNED' ||
    user.accountStatus === 'DELETED' ||
    // The password lockout applies only to a sign-in that STARTED with a
    // password; a provider sign-in is not a password attempt.
    (result.amr.includes('pwd') && user.lockedUntil && user.lockedUntil > new Date()) ||
    (await isUserBlocked(user.id))
  ) {
    // The generic login failure, for the same enumeration reasons as the
    // login route: by now the caller has proven the password AND the factor,
    // but the answer is still "no" and still says nothing more.
    return clearMfaTicketCookie(mfaJson({ error: 'auth.errors.invalidCredentials' }, 401));
  }

  if (result.method === 'recovery') await notifyRecoveryCodeUsed(user.id, result.recoveryCodesRemaining);

  const response = await completeLogin({
    request,
    user,
    deviceFingerprint: result.deviceFingerprint,
    amr: result.amr,
    mfaAt: new Date(),
    // From the ticket's own record of what was proven first: pwd or fed.
    method: `${result.amr.filter((m) => m !== 'otp' && m !== 'recovery').join('+') || 'unknown'}+${result.method}`,
    // Tells the client to warn when recovery codes are running out.
    extra: result.method === 'recovery' ? { recoveryCodesRemaining: result.recoveryCodesRemaining } : undefined,
  });
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  return clearMfaTicketCookie(response);
}
