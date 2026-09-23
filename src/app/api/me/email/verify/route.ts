import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { redeemEmailVerification } from '@/lib/firebase/repositories/emailVerification';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ token: z.string().max(64) }).strict();

/**
 * POST /api/me/email/verify - { token } from the link's fragment.
 *
 * Requires the session of the account the token was issued to (see the
 * repository header for why a bare link must never verify). Signed out, this
 * answers 401 and the page sends the person to sign in first, then retries.
 *
 * Failures answer 400, never 401 - on a signed-in route 401 means "session
 * gone" to the SessionKeeper.
 */
const ERRORS = {
  invalid: 'auth.emailVerify.errors.invalid',
  wrong_account: 'auth.emailVerify.errors.wrongAccount',
  email_changed: 'auth.emailVerify.errors.invalid',
} as const;

export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const limit = await rateLimit('email:verify:redeem', { userId: session.userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: ERRORS.invalid }, 400);

  const result = await redeemEmailVerification(parsed.data.token, session.userId);
  await writeAuditLog({
    actorId: session.userId,
    action: 'EMAIL_VERIFY',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: result === 'verified' || result === 'already_verified' ? 'SUCCESS' : 'DENIED',
    after: { result },
  });

  if (result === 'verified' || result === 'already_verified') return mfaJson({ ok: true, result });
  return mfaJson({ error: ERRORS[result] }, 400);
}
