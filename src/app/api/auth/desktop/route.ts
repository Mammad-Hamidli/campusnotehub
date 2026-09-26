import { NextResponse, type NextRequest } from 'next/server';
import {
  COOKIE_REFRESH,
  markDesktopClient,
  markRefreshed,
  requireSession,
  rotateSession,
  UnauthorizedError,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/desktop - the Windows app's start page.
 *
 * desktop/src-tauri/tauri.conf.json opens the app window here instead of on
 * "/", and the landing page sends the app back here (installs from before that
 * change start on "/"). It does two things a browser visit never needs:
 *
 * 1. Skips the marketing page. A live session goes on to "/", which forwards
 *    it to /dashboard or /admin; everyone else lands on /login.
 * 2. Marks this WebView2 profile as the desktop app (CH_CLIENT), so the next
 *    sign-in gets the desktop session policy - see DESKTOP_SESSION_DAYS in
 *    src/lib/auth/session.ts.
 *
 * It lives under /api/auth because CH_RT is scoped to that path: this is the
 * only kind of route that can see the refresh token, and after a restart the
 * refresh token is usually all the app has - the 15-minute access token has
 * long expired.
 */
export async function GET(request: NextRequest) {
  const response = await land(request);
  response.headers.set('Cache-Control', 'no-store');

  /**
   * Only the app's own navigation may set the marker. The app's start request
   * is browser-initiated (Sec-Fetch-Site: none) and the landing page's hop is
   * same-origin; a link from another site is cross-site. Without this check
   * any page could link a visitor here and quietly turn their NEXT browser
   * sign-in into one that survives closing the browser - the very thing the
   * web session rules exist to prevent on shared computers.
   */
  const site = request.headers.get('sec-fetch-site');
  if (site === 'none' || site === 'same-origin') markDesktopClient(response);

  return response;
}

async function land(request: NextRequest): Promise<NextResponse> {
  const home = new URL('/', request.url);

  // Reopened within the access token's lifetime: nothing to renew.
  try {
    await requireSession(request);
    return markRefreshed(NextResponse.redirect(home));
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }

  const refreshToken = request.cookies.get(COOKIE_REFRESH)?.value;
  if (refreshToken) {
    try {
      const session = await rotateSession(refreshToken, request.headers.get('user-agent') ?? '');
      return markRefreshed(session.applyCookies(NextResponse.redirect(home)));
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }
  }

  return NextResponse.redirect(new URL('/login', request.url));
}
