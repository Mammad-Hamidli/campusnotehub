import { issueEmailVerification } from '@/lib/firebase/repositories/emailVerification';
import { sendEmailAsync } from '@/lib/email/send';
import { appUrl } from '@/lib/email/urls';

/** The confirmation page. NOT under /verify: the middleware protects that prefix. */
export const CONFIRM_EMAIL_PATH = '/confirm-email';

/**
 * Issues a token and emails the link.
 *
 * The token rides in the URL FRAGMENT (`#token=`), which browsers never send
 * to a server: it cannot land in access logs, a CDN log or a Referer header,
 * and the page reads it client-side and POSTs it (see /confirm-email).
 */
export async function sendVerificationEmail(user: { id: string; email: string; nickname: string }): Promise<void> {
  const token = await issueEmailVerification(user.id, user.email);
  sendEmailAsync(user.email, 'emailVerification', {
    nickname: user.nickname,
    url: appUrl(`${CONFIRM_EMAIL_PATH}#token=${token}`),
  });
}
