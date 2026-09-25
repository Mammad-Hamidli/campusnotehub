import { NextResponse, type NextRequest } from 'next/server';
import { browserOrigin, flowOrigin } from '@/lib/app-url';
import { isProviderId, providerConfig } from '@/lib/auth/oauth/providers';
import { beginAuthorization, safeReturnTo } from '@/lib/auth/oauth/flow';
import { outcomeRedirect, setBindingCookie } from '@/lib/auth/oauth/http';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/oauth/[provider]/start?returnTo=/path - "Continue with ...".
 *
 * Sign-in only. A GET is acceptable here because starting a sign-in changes
 * nothing: a page that tricks a browser into this URL at worst shows that
 * person their own provider's consent screen. LINKING, which does change an
 * account, is a separate POST that requires a session and re-authentication
 * (../link/route.ts).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  // The binding cookie is host-only and the callback lands on APP_URL's host,
  // so a start on any other host (the apex domain, a preview URL) would lose
  // the cookie and fail as "expired". Hop to the canonical host first.
  //
  // Compared by HOST as the browser sent it, not by nextUrl.origin: behind a
  // TLS-terminating proxy nextUrl can read http:// (or an internal host), which
  // never equals APP_URL and turned this hop into an endless 308 to itself.
  // Locally (loopback, not production) localhost on the browser's port IS
  // canonical: localhost:3000 goes straight to Google, while 127.0.0.1:3000
  // hops to localhost:3000 first - Google rejects a 127.0.0.1 redirect URI.
  const origin = browserOrigin(request);
  const canonical = flowOrigin(origin);
  if (canonical && new URL(origin).host !== new URL(canonical).host) {
    return NextResponse.redirect(new URL(request.nextUrl.pathname + request.nextUrl.search, canonical), 308);
  }

  const { provider } = await params;
  const config = isProviderId(provider) ? providerConfig(provider) : null;
  if (!config) return outcomeRedirect(request, '/login', 'unavailable');

  const limit = await rateLimit('auth:oauth:start', { ip: clientIp(request.headers) });
  if (!limit.ok) return outcomeRedirect(request, '/login', 'rate_limited');

  const { url, binding } = await beginAuthorization({
    config,
    intent: 'login',
    returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo'), ''),
    userAgent: request.headers.get('user-agent') ?? '',
    requestOrigin: origin,
  });

  // The provider's own URL, built from constants - not an open redirect.
  const response = NextResponse.redirect(url, 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return setBindingCookie(response, binding);
}
