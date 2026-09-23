import type { NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import { sessionHasMfa } from '@/lib/auth/session';
import { getMfa, isEnrolled } from '@/lib/firebase/repositories/mfa';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/mfa - the signed-in account's two-factor status.
 *
 * Returns counts and flags only. Nothing here is a secret, but it still goes
 * out no-store: "has 2FA, 1 recovery code left" is useful reconnaissance.
 */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const record = await getMfa(session.userId);
  const enrolled = isEnrolled(record);
  const staff = session.accountRole === UserRole.ADMIN || session.accountRole === UserRole.MODERATOR;

  return mfaJson({
    enrolled,
    enrolledAt: enrolled ? record.enrolledAt?.toISOString() ?? null : null,
    recoveryCodesRemaining: enrolled ? record.recoveryCodeHashes.length : 0,
    /** Staff must hold a second factor; they cannot switch it off. */
    required: staff,
    /** Whether THIS session proved a second factor. */
    sessionVerified: sessionHasMfa(session.amr),
    locked: !!(record?.lockedUntil && record.lockedUntil > new Date()),
  });
}
