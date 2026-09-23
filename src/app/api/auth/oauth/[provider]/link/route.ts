import type { NextRequest } from 'next/server';
import { browserOrigin } from '@/lib/app-url';
import { z } from 'zod';
import { isProviderId, providerConfig } from '@/lib/auth/oauth/providers';
import { beginAuthorization } from '@/lib/auth/oauth/flow';
import { setBindingCookie } from '@/lib/auth/oauth/http';
import { reauthenticate } from '@/lib/auth/reauth';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    password: z.string().min(1).max(200).optional(),
    code: z.string().trim().max(16).optional(),
    recoveryCode: z.string().trim().max(32).optional(),
  })
  .strict();

/**
 * POST /api/auth/oauth/[provider]/link - { password } | { code } | { recoveryCode }.
 * Answers { url }; the browser then navigates to the provider.
 *
 * ---------------------------------------------------------------------------
 * HOW A PROVIDER IS ATTACHED TO AN EXISTING ACCOUNT ON PURPOSE
 * ---------------------------------------------------------------------------
 * Linking needs a live session AND re-authentication with the account's
 * strongest factor (lib/auth/reauth.ts), because a linked provider is a new
 * way into the account: a stolen session cookie on its own must not be able
 * to add the thief's Google account as a permanent back door.
 *
 * The state records WHICH user and WHICH session started the link; the
 * callback re-checks that session is still live and never trusts an email to
 * decide the account. That is what makes this path safe for a Google account
 * whose email differs from the one on file, or whose email is unverified -
 * neither could ever be matched automatically (see callback.ts, rule 2).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const config = isProviderId(provider) ? providerConfig(provider) : null;
  if (!config) return mfaJson({ error: 'auth.oauth.errors.unavailable' }, 404);

  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const limit = await rateLimit('auth:oauth:start', { ip: clientIp(request.headers) });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const proof = await reauthenticate(request, session, parsed.data);
  if (proof instanceof Response) return proof;

  const { url, binding } = await beginAuthorization({
    config,
    intent: 'link',
    userId: session.userId,
    sessionId: session.sessionId,
    returnTo: '/settings/security',
    userAgent: request.headers.get('user-agent') ?? '',
    requestOrigin: browserOrigin(request),
  });
  return setBindingCookie(mfaJson({ url }), binding);
}
