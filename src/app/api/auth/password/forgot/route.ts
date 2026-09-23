import { after, type NextRequest } from 'next/server';
import { forgotPasswordSchema } from '@/server/validators/auth';
import { requestPasswordReset } from '@/lib/auth/password-reset';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { mfaJson } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/password/forgot - { email }
 *
 * ONE ANSWER FOR EVERY ADDRESS. Registered, unregistered, Google-only, banned,
 * throttled: all get `{ ok: true }` in the same time, because the lookup and
 * the send happen after the response (see requestPasswordReset). Anything else
 * turns this form into the account-enumeration oracle the login route works
 * so hard not to be.
 *
 * The only visible refusals are about the REQUEST, never the account: a
 * malformed address (400) and the per-address limit (429), which is charged
 * whatever the email is.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);

  const limit = await rateLimit('auth:password-reset:ip', { ip });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  const parsed = forgotPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: 'auth.errors.emailInvalid' }, 400);

  const userAgent = request.headers.get('user-agent');
  after(async () => {
    try {
      await requestPasswordReset(parsed.data.email, { ip, userAgent });
    } catch (error) {
      // Never the address: log lines carry no recipient (see email/send.ts).
      console.error('[password-reset] request failed:', error instanceof Error ? error.message : error);
    }
  });

  return mfaJson({ ok: true }, 202);
}
