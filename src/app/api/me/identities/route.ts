import type { NextRequest } from 'next/server';
import { listIdentities } from '@/lib/firebase/repositories/identities';
import { getCredentials } from '@/lib/firebase/repositories/users';
import { enabledProviders } from '@/lib/auth/oauth/providers';
import { reauthRequirement } from '@/lib/auth/reauth';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me/identities - the sign-in methods on this account.
 *
 * `emailHint` is masked ("a****@gmail.com"): enough for the owner to tell
 * which Google account is connected, not a second copy of the address.
 */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const [identities, credential, reauth] = await Promise.all([
    listIdentities(session.userId),
    getCredentials(session.userId),
    reauthRequirement(session.userId),
  ]);

  return mfaJson({
    identities: identities.map((i) => ({
      provider: i.provider,
      emailHint: i.emailHint,
      linkedAt: i.linkedAt.toISOString(),
      lastUsedAt: i.lastUsedAt.toISOString(),
    })),
    available: enabledProviders(),
    hasPassword: typeof credential?.passwordHash === 'string',
    reauth,
  });
}
