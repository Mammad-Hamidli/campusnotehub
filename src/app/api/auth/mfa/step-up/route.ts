import type { NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import { mfaJson, mfaSession, stepUp } from '@/lib/auth/mfa-http';
import { secondFactorSchema } from '@/server/validators/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mfa/step-up - { code } or { recoveryCode }.
 *
 * Proves the second factor on the CURRENT session without signing in again.
 * The case it exists for: a staff session created before the account enrolled
 * (or before this feature shipped) carries no `otp`, so requireSession
 * withholds the staff role; entering a code here restores it on the spot.
 * Later phases reuse it as the generic "confirm it's you" before sensitive
 * account changes.
 */
export async function POST(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const parsed = secondFactorSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const proof = await stepUp(request, session, parsed.data);
  if (proof instanceof Response) return proof;

  const staff = session.accountRole === UserRole.ADMIN || session.accountRole === UserRole.MODERATOR;
  return mfaJson({ ok: true, method: proof.method, next: staff ? { href: '/admin' } : null });
}
