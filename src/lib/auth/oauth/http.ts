import { NextResponse, type NextRequest } from 'next/server';
import { browserOrigin, flowOrigin } from '@/lib/app-url';
import { BINDING_COOKIE, BINDING_COOKIE_PATH } from './flow';

/**
 * Response helpers shared by the OAuth routes.
 *
 * Every OAuth outcome is a navigation, so errors are REDIRECTS to a page with
 * a short code (`?oauth=expired`) that the page translates - never an error
 * body, and never provider-supplied text (an `error_description` from a
 * callback URL is attacker-controllable and must not be rendered).
 */

export type OAuthOutcome =
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'unavailable'
  | 'link_required'
  | 'identity_in_use'
  | 'provider_already_linked'
  | 'rate_limited'
  | 'account_deleted';

/** Public base for redirects: APP_URL (or loopback in dev), never a Host header an attacker can set. */
export function appBase(request: NextRequest): string {
  return flowOrigin(browserOrigin(request)) ?? request.nextUrl.origin;
}

export function redirectTo(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, appBase(request)), 303);
  response.headers.set('Cache-Control', 'no-store');
  // Don't leak the callback URL (with its code) to the next page's requests.
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export function outcomeRedirect(
  request: NextRequest,
  page: '/login' | '/settings/security',
  outcome: OAuthOutcome,
  extra: Record<string, string> = {},
): NextResponse {
  const params = new URLSearchParams({ oauth: outcome, ...extra });
  return clearBindingCookie(redirectTo(request, `${page}?${params}`));
}

/**
 * SameSite=Lax, not None: Google's callback is a top-level GET navigation,
 * which carries a Lax cookie, so Lax keeps the cookie off every cross-site
 * subresource request while still reaching the callback.
 *
 * `secure` stays on except in development, where the app is served over plain
 * http://localhost.
 */
const bindingCookieOptions = {
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: BINDING_COOKIE_PATH,
};

export function setBindingCookie(response: NextResponse, value: string): NextResponse {
  response.cookies.set(BINDING_COOKIE, value, { ...bindingCookieOptions, maxAge: 10 * 60 });
  return response;
}

export function clearBindingCookie(response: NextResponse): NextResponse {
  response.cookies.set(BINDING_COOKIE, '', { ...bindingCookieOptions, maxAge: 0 });
  return response;
}
