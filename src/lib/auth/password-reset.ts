import { findUserByEmail, getCredentials } from '@/lib/firebase/repositories/users';
import { issuePasswordReset, PASSWORD_RESET_TTL_MS } from '@/lib/firebase/repositories/passwordResets';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { rateLimit } from '@/lib/security/ratelimit';
import { sendEmail } from '@/lib/email/send';
import { appUrl } from '@/lib/email/urls';

/** The page the link opens. Public: the person it is for cannot sign in. */
export const RESET_PASSWORD_PATH = '/reset-password';

export type ResetRequestOutcome = 'sent' | 'no_account' | 'no_password' | 'throttled';

/**
 * The work behind "Forgot your password?", run AFTER the response is sent.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RUNS AFTER THE RESPONSE
 * ---------------------------------------------------------------------------
 * The route answers the same `{ ok: true }` for every well-formed address, but
 * identical TEXT is not enough (see the login route's timing note): a known
 * address costs a credential read, a transaction and an SMTP handshake, an
 * unknown one costs a single query. Doing all of it in `after()` makes the
 * response time independent of whether the account exists, which a dummy
 * delay could only approximate.
 *
 * The outcome is returned for the audit log and the tests, never to the
 * client.
 *
 * ---------------------------------------------------------------------------
 * WHO GETS A LINK
 * ---------------------------------------------------------------------------
 * Only an account that HAS a password. An account created through Google has
 * none, and a reset link must not become a way to bolt one onto it - that
 * would turn control of the mailbox into a second, silent way in that the
 * owner never set up.
 *
 * Staff included: a reset replaces the password, not the second factor, so an
 * enrolled account still needs its authenticator at the next sign-in.
 */
export async function requestPasswordReset(
  email: string,
  context: { ip: string; userAgent?: string | null },
): Promise<ResetRequestOutcome> {
  const user = await findUserByEmail(email);
  if (!user || user.deletedAt || user.accountStatus === 'BANNED' || user.accountStatus === 'DELETED') {
    return 'no_account';
  }

  const credential = await getCredentials(user.id);
  if (typeof credential?.passwordHash !== 'string') return 'no_password';

  // Per account, consumed per email: this is what protects the inbox owner.
  const budget = await rateLimit('auth:password-reset', { userId: user.id, ip: context.ip });
  if (!budget.ok) return 'throttled';

  const token = await issuePasswordReset({ userId: user.id, email: user.email, passwordHash: credential.passwordHash });

  /**
   * The token rides in the URL FRAGMENT, as in the email-verification link:
   * browsers never send a fragment to a server, so it cannot reach an access
   * log, a CDN log or a Referer header. /reset-password reads it client-side
   * and POSTs it.
   *
   * sendEmail, awaited - not sendEmailAsync. This already runs inside the
   * route's after() task, which keeps the invocation alive until it returns.
   */
  await sendEmail(user.email, 'passwordResetLink', {
    nickname: user.nickname,
    url: appUrl(`${RESET_PASSWORD_PATH}#token=${token}`),
    minutes: PASSWORD_RESET_TTL_MS / 60_000,
  });

  await writeAuditLog({
    actorId: null,
    action: 'PASSWORD_RESET_REQUESTED',
    entityType: 'user',
    entityId: user.id,
    userAgent: context.userAgent?.slice(0, 512),
    result: 'SUCCESS',
  });
  return 'sent';
}
