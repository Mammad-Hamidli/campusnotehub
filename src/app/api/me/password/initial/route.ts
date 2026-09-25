import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { isRecentSignIn } from '@/lib/auth/reauth';
import { setInitialPasswordSchema } from '@/server/validators/auth';
import { findUserById, setInitialPassword } from '@/lib/firebase/repositories/users';
import { revokePasswordResets } from '@/lib/firebase/repositories/passwordResets';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { hashPassword } from '@/lib/crypto/hash';
import { sendEmailAsync } from '@/lib/email/send';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/me/password/initial - { password }
 *
 * The FIRST password of an account that signed up through Google (see
 * /set-password). There is no current password to ask for, so the proof is a
 * RECENT Google sign-in instead - the same rule reauth.ts applies to a
 * social-only account. A session that is merely old (or borrowed) cannot add
 * a new way in.
 *
 * Refused with 409 once any password exists: changing one needs the current
 * password, which is POST /api/me/password.
 *
 * Failures answer 400/403/409, never 401: on a signed-in route 401 means
 * "session gone" to the SessionKeeper.
 */
export async function POST(request: NextRequest) {
  let userId: string;
  let authenticatedAt: Date;
  try {
    ({ userId, authenticatedAt } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const budget = await rateLimit('auth:password-change', { userId, ip: clientIp(request.headers) });
  if (!budget.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
    );
  }

  const parsed = setInitialPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path[0] === 'password' && i.message.startsWith('auth.'));
    return NextResponse.json({ error: issue?.message ?? 'errors.validationFailed', field: 'password' }, { status: 400 });
  }

  if (!isRecentSignIn(authenticatedAt)) {
    return NextResponse.json({ error: 'auth.setPassword.errors.signInAgain' }, { status: 403 });
  }

  const result = await setInitialPassword(userId, await hashPassword(parsed.data.password));
  if (result === 'already_set') {
    return NextResponse.json({ error: 'auth.setPassword.errors.alreadySet' }, { status: 409 });
  }
  await revokePasswordResets(userId);

  await writeAuditLog({
    actorId: userId,
    action: 'PASSWORD_SET',
    entityType: 'user',
    entityId: userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
  });

  const user = await findUserById(userId);
  if (user) sendEmailAsync(user.email, 'passwordChanged', { nickname: user.nickname });

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
