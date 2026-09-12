import { NextResponse, type NextRequest } from 'next/server';
import {
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  clearSessionCookies,
  revokeSession,
  revokeSessionById,
  sessionIdFromAccessToken,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /logout
 *
 * A route handler rather than a page: logging out has no UI, and rendering a
 * "logging you out..." screen only creates a window where the user is unsure
 * whether it worked.
 *
 * GET is used because /logout is a plain link in the nav. That is normally a
 * CSRF smell — an attacker can force a logout with an <img> tag — but the
 * worst outcome is a nuisance sign-out, and the alternative (a POST form in
 * every menu) is worse ergonomics for no meaningful security gain. Anything
 * that changes state beyond ending a session stays POST-only.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REVOKES BY SESSION ID AS WELL AS BY REFRESH TOKEN
 * ---------------------------------------------------------------------------
 * CH_RT is scoped to `path=/api/auth`, so it is deliberately NOT sent to this
 * page-level route. That meant the original handler's `revokeSession(CH_RT)`
 * found no cookie and did nothing at all on a normal sign-out: the only real
 * effect was deleting cookies from that one browser, while the session row
 * stayed live and its access token stayed valid for the rest of its TTL.
 *
 * That is the server half of the "log out, press back, still in the admin
 * panel" report. The client half was the browser restoring a cached page; the
 * server half was that the credential behind it had never actually been
 * revoked. Reading the session id from the access token and revoking THAT row
 * closes it, and requireSession() now checks the row on every request, so the
 * revocation takes effect immediately and everywhere.
 */
export async function GET(request: NextRequest) {
  /**
   * The session id comes from sessionIdFromAccessToken(), not requireSession().
   *
   * requireSession() enforces the expiry, so it threw for anyone signing out
   * after their access token had aged past its TTL - and this handler then
   * revoked nothing at all. Verifying the signature while ignoring `exp` is
   * enough to safely identify a session for DESTRUCTION, and it makes sign-out
   * revoke the row on every path rather than only the fresh one. See that
   * function for why ignoring the expiry is sound here and nowhere else.
   */
  const accessToken = request.cookies.get(COOKIE_ACCESS)?.value;
  const sessionId = accessToken ? await sessionIdFromAccessToken(accessToken) : null;
  if (sessionId) {
    // Best effort: an already-revoked session simply has nothing left to
    // revoke, and signing out must succeed regardless.
    await revokeSessionById(sessionId).catch(() => {});
  }

  // Also honour a refresh token if one did reach us (a direct call to this
  // path from an /api/auth context), so both halves of the pair die together.
  const refreshToken = request.cookies.get(COOKIE_REFRESH)?.value;
  if (refreshToken) {
    await revokeSession(refreshToken).catch(() => {});
  }

  /**
   * `?next=` lets a page whose session died server-side (revoked, wiped,
   * banned) send the user here to drop the stale cookies and land on /login.
   * Without it the edge middleware, which can only check the JWT signature,
   * keeps bouncing /login back to /dashboard while every API call returns 401.
   * Same-origin paths only: `//host` and `/\host` would be open redirects.
   */
  const next = request.nextUrl.searchParams.get('next');
  const target = next && /^\/(?![/\\])/.test(next) ? next : '/';

  const response = NextResponse.redirect(new URL(target, request.url));
  clearSessionCookies(response);

  /**
   * Stops the browser serving the PREVIOUS page from its back/forward cache.
   *
   * Without this, pressing Back after signing out re-displays the fully
   * rendered admin panel straight from memory - no request is made, so no
   * amount of server-side authorization is consulted. `no-store` is the header
   * that disqualifies a page from the bfcache in Chrome and Firefox, which is
   * why it is set here and, more importantly, on the admin responses
   * themselves in middleware.ts.
   */
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  /**
   * `storage` alongside `cache`.
   *
   * `cache` alone was doing half the job: it disqualifies the previous page
   * from the bfcache, but it leaves localStorage, sessionStorage, IndexedDB and
   * any Cache Storage entry untouched. Adding `storage` wipes all of it, so
   * nothing a signed-in page wrote can be read by the next person to use the
   * browser - and a future feature that caches profile data client-side is
   * covered by this line the day it is written rather than the day it leaks.
   *
   * `cookies` is deliberately NOT in the list. It would clear the whole
   * registrable domain, taking CH_LOCALE with it, so signing out would silently
   * reset the interface language. The auth cookies are already deleted by name
   * and by path in clearSessionCookies(), which is exact rather than
   * approximate.
   */
  response.headers.set('Clear-Site-Data', '"cache", "storage"');
  return response;
}
