import type { NextRequest } from 'next/server';
import { regenerateRecoveryCodes } from '@/lib/firebase/repositories/mfa';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sendEmailAsync } from '@/lib/email/send';
import { mfaJson, mfaSession, stepUp } from '@/lib/auth/mfa-http';
import { secondFactorSchema } from '@/server/validators/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mfa/recovery-codes - { code } or { recoveryCode }.
 *
 * Replaces ALL recovery codes. Requires a fresh second factor: new codes are
 * a way back into the account, so minting them is as sensitive as the
 * authenticator itself. Stepping up with a recovery code is allowed (that code
 * is spent first), which is how someone down to their last code refills.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const parsed = secondFactorSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const proof = await stepUp(request, session, parsed.data);
  if (proof instanceof Response) return proof;

  const codes = await regenerateRecoveryCodes(session.userId);
  if (!codes) return mfaJson({ error: 'auth.errors.mfaNotEnrolled' }, 409);

  const user = await findUserById(session.userId);
  if (user) sendEmailAsync(user.email, 'mfaRecoveryCodesRegenerated', { nickname: user.nickname });

  await writeAuditLog({
    actorId: session.userId,
    action: 'MFA_RECOVERY_CODES_REGENERATED',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
  });

  return mfaJson({ recoveryCodes: codes });
}
