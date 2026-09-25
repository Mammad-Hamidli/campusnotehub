import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { peekDeviceLink, redeemDeviceLink } from '@/lib/firebase/repositories/deviceLinks';
import { findUserById, type UserRecord } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { isUserBlocked } from '@/lib/security/blocklist';
import { clientIp, peekRateLimit, rateLimit } from '@/lib/security/ratelimit';
import { visibleAvatar } from '@/lib/profile/visibility';
import { completeLogin } from '@/lib/auth/complete-login';
import { mfaJson } from '@/lib/auth/mfa-http';
import { sessionIsLive } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  token: z.string().max(64),
  /** false: only say which account the code is for. true: sign in. */
  confirm: z.boolean().default(false),
});

const INVALID = 'auth.deviceLink.errors.invalid';

/** The account if it may sign in right now: the live-state checks the password and MFA routes run. */
async function signInAllowed(userId: string | null | undefined): Promise<UserRecord | null> {
  const user = userId ? await findUserById(userId) : null;
  if (!user || user.deletedAt || user.accountStatus === 'BANNED' || user.accountStatus === 'DELETED') return null;
  return (await isUserBlocked(user.id)) ? null : user;
}

/**
 * POST /api/auth/device-link - { token, confirm } from /link-device.
 *
 * Two steps on purpose. `confirm: false` names the account without consuming
 * the code; the page asks "Sign in as @nickname?" and only then sends
 * `confirm: true`. Without that stop, a code the attacker generated for THEIR
 * account and sent as a link would sign the victim in as the attacker, and
 * whatever the victim then uploads - ID documents included - lands there.
 *
 * Every refusal is the same 401, and every refusal is charged to the address:
 * cycling random codes must cost as much as guessing a password.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const budget = await peekRateLimit('auth:deviceLink:ip', { ip });
  if (!budget.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);
  const { token, confirm } = parsed.data;
  const refuse = async () => {
    await rateLimit('auth:deviceLink:ip', { ip });
    return mfaJson({ error: INVALID }, 401);
  };

  if (!confirm) {
    const user = await signInAllowed(await peekDeviceLink(token));
    if (!user) return refuse();
    return mfaJson({
      account: { nickname: user.nickname, fullName: user.fullName, avatarUrl: visibleAvatar(user, null) },
    });
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  const result = await redeemDeviceLink({ token, userAgent, issuerIsLive: (row) => sessionIsLive(row) });
  const user = result.ok ? await signInAllowed(result.userId) : null;

  if (!result.ok || !user) {
    const userId = result.userId;
    if (userId) {
      await writeAuditLog({
        actorId: userId,
        action: 'USER_LOGIN',
        entityType: 'user',
        entityId: userId,
        userAgent: userAgent.slice(0, 512),
        result: 'FAILURE',
        after: { method: 'qr_link' },
      });
    }
    return refuse();
  }

  const response = await completeLogin({
    request,
    user,
    amr: result.amr,
    mfaAt: result.mfaAt,
    method: 'qr_link',
  });
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  return response;
}
