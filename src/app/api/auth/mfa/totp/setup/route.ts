import type { NextRequest } from 'next/server';
import { beginEnrollment, getMfa, isEnrolled } from '@/lib/firebase/repositories/mfa';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { formatSecretForManualEntry, otpauthUri, qrSvgDataUrl } from '@/lib/auth/totp';
import { mfaJson, mfaSession, stepUp } from '@/lib/auth/mfa-http';
import { mfaSetupSchema } from '@/server/validators/auth';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What authenticator apps show above the code. Stable: changing it only relabels. */
const ISSUER = process.env.TOTP_ISSUER?.trim() || 'CampusHub';

/**
 * POST /api/auth/mfa/totp/setup - starts (or restarts) an enrollment.
 *
 * Body: {} for a first enrollment; { code } or { recoveryCode } to REPLACE an
 * existing authenticator.
 *
 * ---------------------------------------------------------------------------
 * WHY REPLACING DEMANDS THE CURRENT FACTOR
 * ---------------------------------------------------------------------------
 * Without it, anyone holding a session - a stolen cookie, an unlocked laptop -
 * could enroll THEIR phone and lock the owner out of their own second factor.
 * The first enrollment cannot demand a factor that does not exist yet; it is
 * covered by the confirmation email and the audit row instead.
 *
 * The secret is created as PENDING and returned exactly once. It only becomes
 * the active factor when /totp/confirm proves the app is producing codes for
 * it, so a half-finished setup never locks anyone out.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const budget = await rateLimit('auth:mfa:setup', { userId: session.userId, ip: clientIp(request.headers) });
  if (!budget.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const parsed = mfaSetupSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const existing = await getMfa(session.userId);
  const replacing = isEnrolled(existing);
  if (replacing) {
    if (!parsed.data.code && !parsed.data.recoveryCode) {
      return mfaJson({ error: 'auth.errors.mfaStepUpRequired' }, 403);
    }
    const proof = await stepUp(request, session, parsed.data);
    if (proof instanceof Response) return proof;
  }

  const user = await findUserById(session.userId);
  if (!user) return mfaJson({ error: 'errors.sessionExpired' }, 401);

  const secret = await beginEnrollment(session.userId);
  const uri = otpauthUri(secret, user.nickname, ISSUER);
  const body = {
    otpauthUri: uri,
    qrCode: qrSvgDataUrl(uri),
    manualEntryKey: formatSecretForManualEntry(secret),
    issuer: ISSUER,
    accountLabel: user.nickname,
    replacing,
  };
  secret.fill(0);

  await writeAuditLog({
    actorId: session.userId,
    action: 'MFA_SETUP_STARTED',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { replacing },
  });

  return mfaJson(body);
}
