import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { redeemEmailChange } from '@/lib/firebase/repositories/emailChanges';
import { revokeOtherUserSessions } from '@/lib/firebase/repositories/sessions';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { sendEmailAsync } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ token: z.string().max(64) }).strict();

const ERRORS = {
  invalid: 'settings.email.errors.linkInvalid',
  wrong_account: 'auth.emailVerify.errors.wrongAccount',
  stale: 'settings.email.errors.linkInvalid',
  taken: 'settings.email.errors.taken',
} as const;

/**
 * POST /api/me/email/change/confirm { token }
 *
 * Finishes a change started at POST /api/me/email/change. Needs a session of
 * the SAME account that asked (the link alone is not enough), which is what
 * stops a forwarded or intercepted link from moving someone else's account.
 * On success every OTHER device is signed out and the old address is told,
 * so a takeover that got this far is at least loud.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const limit = await rateLimit('email:change:redeem', { userId: session.userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: ERRORS.invalid }, 400);

  const result = await redeemEmailChange(parsed.data.token, session.userId);
  await writeAuditLog({
    actorId: session.userId,
    action: 'EMAIL_CHANGE',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: result.status === 'changed' ? 'SUCCESS' : 'DENIED',
    after: { result: result.status },
  });

  if (result.status !== 'changed') {
    return mfaJson({ error: ERRORS[result.status] }, result.status === 'taken' ? 409 : 400);
  }

  const [revoked, user] = await Promise.all([
    revokeOtherUserSessions(session.userId, session.sessionId),
    findUserById(session.userId),
  ]);
  if (user) sendEmailAsync(result.fromEmail, 'emailChanged', { nickname: user.nickname, newEmail: result.toEmail });

  return mfaJson({ ok: true, email: result.toEmail, revokedSessions: revoked });
}
