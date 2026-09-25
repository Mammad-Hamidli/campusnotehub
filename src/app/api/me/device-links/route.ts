import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { createDeviceLink } from '@/lib/firebase/repositories/deviceLinks';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { reauthenticate, reauthRequirement } from '@/lib/auth/reauth';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { qrSvgDataUrl } from '@/lib/auth/totp';
import { browserOrigin } from '@/lib/app-url';
import { appUrl } from '@/lib/email/urls';
import { clientIp, peekRateLimit, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/me/device-links - which proof issuing a QR code will ask for. */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;
  return mfaJson({ reauth: await reauthRequirement(session.userId) });
}

const bodySchema = z.object({
  password: z.string().max(256).optional(),
  code: z.string().max(16).optional(),
  recoveryCode: z.string().max(32).optional(),
});

/**
 * POST /api/me/device-links - issue a QR sign-in code (Settings -> Devices).
 *
 * A code is a session-in-waiting, so issuing one demands the same "prove it
 * is still you" as linking a sign-in method (lib/auth/reauth.ts): an unlocked
 * laptop left on a desk must not be able to copy its session to a stranger's
 * phone.
 *
 * WHAT THE NEW SESSION CARRIES. amr gets 'qr' plus, when the proof was an
 * authenticator or recovery code, that factor - proven seconds ago, by the
 * owner, for exactly this purpose. A password proof adds nothing ('pwd'
 * would also clear the password lockout on sign-in; see completeLogin), and
 * nothing is inherited from the issuing session: its 'otp' may be weeks old.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const identity = { userId: session.userId, ip: clientIp(request.headers) };
  const budget = await peekRateLimit('auth:deviceLink:create', identity);
  if (!budget.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const reauth = await reauthenticate(request, session, parsed.data);
  if (reauth instanceof Response) return reauth;
  await rateLimit('auth:deviceLink:create', identity);

  const factor = reauth.method === 'totp' ? 'otp' : reauth.method === 'recovery' ? 'recovery' : null;
  const link = await createDeviceLink({
    userId: session.userId,
    sessionId: session.sessionId,
    amr: factor ? ['qr', factor] : ['qr'],
    mfaAt: factor ? new Date() : null,
  });

  await writeAuditLog({
    actorId: session.userId,
    action: 'DEVICE_LINK_CREATED',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { method: reauth.method },
  });

  /**
   * Production: the canonical origin, never a Host header. Development: the
   * address this browser used, so a phone on the same network can open it
   * (a code pointing at "localhost" would open the phone itself).
   *
   * The token rides in the FRAGMENT: it never reaches a server log, a proxy
   * or a link-preview fetch, and /link-device strips it on arrival.
   */
  const origin = process.env.NODE_ENV === 'production' ? appUrl() : browserOrigin(request);
  return mfaJson({
    id: link.id,
    qr: qrSvgDataUrl(`${origin}/link-device#t=${link.token}`),
    // Relative, so the countdown does not depend on the client's clock.
    expiresIn: Math.round((link.expiresAt.getTime() - Date.now()) / 1000),
  });
}
