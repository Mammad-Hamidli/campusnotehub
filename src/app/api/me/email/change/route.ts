import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { hashEmail } from '@/lib/crypto/hash';
import { findUserById, findUserByEmail, findUserIdByEmailHash } from '@/lib/firebase/repositories/users';
import { EMAIL_CHANGE_TTL_MS, issueEmailChange } from '@/lib/firebase/repositories/emailChanges';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { checkSignupBlocked } from '@/lib/security/blocklist';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { reauthenticate, reauthRequirement } from '@/lib/auth/reauth';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { sendEmailAsync } from '@/lib/email/send';
import { appUrl } from '@/lib/email/urls';
import { CONFIRM_EMAIL_CHANGE_PATH } from '@/lib/auth/email-verification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/me/email/change - which proof starting a change will ask for. */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;
  return mfaJson({ reauth: await reauthRequirement(session.userId) });
}

const bodySchema = z.object({
  newEmail: z.string().trim().toLowerCase().email('auth.errors.emailInvalid').max(254),
  password: z.string().max(256).optional(),
  code: z.string().max(16).optional(),
  recoveryCode: z.string().max(32).optional(),
});

/**
 * POST /api/me/email/change { newEmail, password | code | recoveryCode }
 *
 * Starts a change; nothing about the account moves yet. The holder proves
 * themselves first (reauthenticate(): authenticator code when 2FA is on,
 * otherwise the current password, otherwise a sign-in in the last minutes),
 * then a single-use link goes to the NEW address and a heads-up to the OLD
 * one. The move happens only at /confirm-email-change, from a session of this
 * same account (POST /api/me/email/change/confirm).
 *
 * "Taken" is answered here as a convenience for the honest user; the real
 * uniqueness check is repeated inside the confirming transaction.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return mfaJson({ error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors }, 400);
  }
  const { newEmail, ...proof } = parsed.data;

  const user = await findUserById(session.userId);
  if (!user || user.deletedAt) return mfaJson({ error: 'errors.sessionExpired' }, 401);
  if (newEmail === user.email.toLowerCase()) return mfaJson({ error: 'settings.email.errors.same' }, 400);

  const reauth = await reauthenticate(request, session, proof);
  if (reauth instanceof Response) return reauth;

  const limit = await rateLimit('email:change', { userId: user.id, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  const [blocked, byEmail, byHash] = await Promise.all([
    checkSignupBlocked({ email: newEmail }),
    findUserByEmail(newEmail),
    findUserIdByEmailHash(hashEmail(newEmail)),
  ]);
  // A blocked address reads as "taken": which addresses are banned is not
  // something this endpoint should be able to enumerate.
  if (blocked.blocked || (byEmail && byEmail.id !== user.id) || (byHash && byHash !== user.id)) {
    return mfaJson({ error: 'settings.email.errors.taken' }, 409);
  }

  const token = await issueEmailChange(user.id, user.email, newEmail);
  sendEmailAsync(newEmail, 'emailChangeConfirm', {
    nickname: user.nickname,
    url: appUrl(`${CONFIRM_EMAIL_CHANGE_PATH}#token=${token}`),
    minutes: Math.round(EMAIL_CHANGE_TTL_MS / 60_000),
  });
  sendEmailAsync(user.email, 'emailChangeRequested', { nickname: user.nickname, newEmail });

  await writeAuditLog({
    actorId: user.id,
    action: 'EMAIL_CHANGE_REQUESTED',
    entityType: 'user',
    entityId: user.id,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { method: reauth.method },
  });

  return mfaJson({ ok: true, pendingEmail: newEmail });
}
