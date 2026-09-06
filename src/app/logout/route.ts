import { NextResponse, type NextRequest } from 'next/server';
import {
  clearSessionCookies,
  requireSession,
  revokeSession,
  revokeSessionById,
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
  // Best effort: an already-expired or already-revoked session simply has
  // nothing to revoke, and signing out must succeed regardless.
  try {
    const { sessionId } = await requireSession(request);
    await revokeSessionById(sessionId);
  } catch {
    // Not signed in, or the session is already dead. Clearing cookies below is
    // still the correct response.
  }

  // Also honour a refresh token if one did reach us (a direct call to this
  // path from an /api/auth context), so both halves of the pair die together.
  const refreshToken = request.cookies.get('CH_RT')?.value;
  if (refreshToken) {
    await revokeSession(refreshToken).catch(() => {});
  }

  const response = NextResponse.redirect(new URL('/', request.url));
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
  response.headers.set('Clear-Site-Data', '"cache"');
  return response;
}
