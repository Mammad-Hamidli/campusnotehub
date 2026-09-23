import type { NextRequest } from 'next/server';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { sendVerificationEmail } from '@/lib/auth/email-verification';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/me/email/verification - (re)send the confirmation link.
 *
 * Signed-in only, and always to the account's OWN address: this endpoint can
 * never be pointed at somebody else's inbox. Each send revokes the previous
 * link, so only the newest one in the inbox works.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const user = await findUserById(session.userId);
  if (!user || user.deletedAt) return mfaJson({ error: 'errors.sessionExpired' }, 401);
  if (user.emailVerifiedAt) return mfaJson({ error: 'auth.emailVerify.errors.alreadyVerified' }, 409);

  const ip = clientIp(request.headers);
  for (const [key, identity] of [
    ['email:verify:send', { userId: user.id, ip }],
    ['email:verify:send:ip', { ip }],
  ] as const) {
    const limit = await rateLimit(key, identity);
    if (!limit.ok) {
      return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
    }
  }

  await sendVerificationEmail(user);
  await writeAuditLog({
    actorId: user.id,
    action: 'EMAIL_VERIFICATION_SENT',
    entityType: 'user',
    entityId: user.id,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
  });
  return mfaJson({ ok: true });
}
