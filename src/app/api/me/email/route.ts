import type { NextRequest } from 'next/server';
import { findUserById } from '@/lib/firebase/repositories/users';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/me/email - the account's address and whether it is verified. Owner only. */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;
  const user = await findUserById(session.userId);
  if (!user) return mfaJson({ error: 'errors.sessionExpired' }, 401);
  return mfaJson({
    email: user.email,
    verified: !!user.emailVerifiedAt,
    verifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
  });
}
