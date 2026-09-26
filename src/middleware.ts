import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify, importSPKI } from 'jose';

/**
 * Edge middleware: CSP nonce + auth gating.
 *
 * Locale is NOT handled here. It lives in the CH_LOCALE cookie, is read by the
 * root layout on the server, and is switched client-side by LocaleProvider —
 * see src/lib/i18n/dictionaries.ts for the SEO trade-off that implies.
 */

/** Routes that require a session. */
const PROTECTED = [
  /^\/(dashboard|settings|notifications|profile|bookmarks|bookings|verify|onboarding|set-password)/,
  /^\/notes\/new/,
  /**
   * /mentors/apply is deliberately NOT here.
   *
   * It used to be, and that is what made "apply as a mentor" impossible for
   * anyone without an account: a signed-out visitor clicking "Become a mentor"
   * was bounced to /api/auth/refresh and on to /login, which offers no way to
   * create the mentor account they came for. The page now renders its own
   * signed-out state pointing at the mentors site (MENTORS_URL).
   *
   * This removes NO authorization. Submitting an application is POST
   * /api/mentors/apply, which independently requires a session, an active
   * account and a VERIFIED identity - the middleware never was the control.
   */
  // Role is re-checked against live DB state in the /admin layout and in every
  // /api/admin handler; the middleware only guarantees "signed in", because it
  // has no DB access.
  /^\/admin/,
];

/**
 * Routes whose HTML must never be reusable by the browser.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE FIX FOR "LOG OUT, PRESS BACK, THE ADMIN PANEL IS STILL THERE"
 * ---------------------------------------------------------------------------
 * The server-side authorization was never the problem: the /admin layout
 * checks the role against live database state, and every /api/admin handler
 * re-checks independently. The problem was that pressing Back does not
 * necessarily make a request AT ALL.
 *
 * Browsers keep a back/forward cache (bfcache) - a snapshot of the fully
 * rendered, still-alive page. Restoring from it runs no server code, so a
 * panel rendered while signed in is re-displayed verbatim after signing out,
 * with the real account data still painted on it. No amount of route
 * protection can intercept that, because nothing is being routed.
 *
 * `Cache-Control: no-store` is the documented way out: Chrome and Firefox both
 * refuse to bfcache a document served with it, and it simultaneously stops the
 * ordinary disk cache from re-serving the HTML. So Back becomes a real
 * request, which reaches the layout, which finds no session and redirects.
 *
 * It is applied to every authenticated route rather than only /admin, because
 * a student's dashboard restored on a shared library machine after sign-out is
 * the same disclosure with a smaller blast radius.
 */
const NO_STORE = [
  /^\/(admin|dashboard|settings|notifications|profile|bookmarks|bookings|verify)/,
  /^\/notes\/new/,
  /**
   * The auth screens are here too, and that is not cosmetic.
   *
   * /login decides whether to show the form or send an already-signed-in user
   * on to their dashboard, so its response depends entirely on session state -
   * exactly the thing that must never be served from a cache. A stored copy of
   * either answer is wrong for the other visitor, and a stored REDIRECT is
   * worse: it sends someone who just signed out straight back to a signed-in
   * route without ever asking the server.
   *
   * The password-reset screens carry no session state, but they do handle a
   * live credential (the link's token) and a new password: nothing about them
   * belongs in a back/forward cache.
   */
  /^\/(login|register|forgot-password|reset-password)$/,
  /^\/logout$/,
];

/**
 * Expires every auth cookie on a response.
 *
 * Deliberately a local copy of clearSessionCookies() rather than an import of
 * it: this file runs on the edge runtime, and src/lib/auth/session.ts pulls in
 * firebase-admin, which cannot be bundled there. The duplication is four cookie
 * names; importing the real one would not compile.
 */
function clearAuthCookies(response: NextResponse): NextResponse {
  const expire = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 0,
    expires: new Date(0),
  };
  response.cookies.set('CH_AT', '', { ...expire, path: '/' });
  response.cookies.set('CH_RT', '', { ...expire, path: '/api/auth' });
  response.cookies.set('CH_RF', '', { ...expire, path: '/' });
  // Raw header, because cookies.set() keys by name and would REPLACE the
  // /api/auth expiry above rather than add to it - see clearSessionCookies().
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.headers.append(
    'set-cookie',
    `CH_RT=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
  );
  return response;
}

let publicKeyPromise: Promise<CryptoKey> | null = null;
const getPublicKey = () => {
  publicKeyPromise ??= importSPKI(process.env.JWT_PUBLIC_KEY_PEM!, 'EdDSA');
  return publicKeyPromise;
};

export async function middleware(request: NextRequest) {
  // Per-request CSP nonce. Generated in middleware rather than a layout so the
  // header and the rendered HTML agree on streaming responses.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const isDev = process.env.NODE_ENV !== 'production';

  /**
   * DEVELOPMENT ONLY: 'unsafe-eval' and the HMR websocket.
   *
   * This is not a loosening of the production policy - it is the fix for a bug
   * that made the entire app look broken in development.
   *
   * `next dev` compiles the client bundle with an eval-based devtool, so every
   * module is instantiated through `eval()`. Without 'unsafe-eval' the browser
   * refuses the very first chunk with
   *   EvalError: Evaluating a string as JavaScript violates ... CSP
   * and React never hydrates. The server-rendered HTML still paints, so the
   * page LOOKS fine while nothing is interactive: menus do not open, the theme
   * and language switchers do nothing, and form buttons are inert. Every
   * "component X is broken" report in dev traces back to this one line.
   *
   * Production is untouched and still has no 'unsafe-eval': a production build
   * ships real script files with no eval, so it never needed it. Next.js
   * inlines process.env.NODE_ENV as the literal 'production' string when it
   * builds, so `isDev` folds to false and the minifier strips these branches -
   * the relaxed sources cannot reach a deployed bundle even by accident.
   */
  const scriptSrc = [
    `'self'`,
    `'nonce-${nonce}'`,
    `'strict-dynamic'`,
    `https:`,
    ...(isDev ? [`'unsafe-eval'`] : []),
  ].join(' ');

  const connectSrc = [
    `'self'`,
    // Post translation runs in the browser against MyMemory's free API; see
    // src/lib/translate/mymemory.ts.
    `https://api.mymemory.translated.net`,
    // The dev server pushes hot updates over a plain-ws connection to
    // localhost, which 'self' does not cover once a scheme is involved.
    ...(isDev ? [`ws:`] : []),
  ].join(' ');

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`, // Tailwind emits inline styles for animations
    `img-src 'self' data: blob:`,
    `media-src 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    `frame-src 'self' https://meet.campusnotehub.com`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `base-uri 'none'`,
    `object-src 'none'`,
    // Would rewrite http://localhost to https:// in dev and break every asset.
    ...(isDev ? [] : [`upgrade-insecure-requests`]),
  ].join('; ');

  /**
   * The nonce has to travel on the REQUEST headers, not just the response.
   *
   * Next.js looks for a Content-Security-Policy on the incoming request to
   * discover the nonce, and stamps that value onto every <script> tag it emits
   * for the bundle. Setting it only on the response - which is what this did
   * before - leaves those tags bare. That is invisible under a permissive
   * policy but fatal under 'strict-dynamic', because strict-dynamic tells the
   * browser to IGNORE 'self' and https: and trust nonce-carrying scripts only.
   * Passing it through here is also what lets the root layout read x-nonce for
   * the inline theme script.
   */
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);

  const { pathname } = request.nextUrl;
  const token = request.cookies.get('CH_AT')?.value;
  let session: { sub: string; ver: string } | null = null;

  if (token && process.env.JWT_PUBLIC_KEY_PEM) {
    try {
      const { payload } = await jwtVerify(token, await getPublicKey(), {
        issuer: 'campusnotehub',
        audience: 'campusnotehub-web',
      });
      session = { sub: payload.sub!, ver: String(payload.ver ?? 'UNVERIFIED') };
    } catch {
      session = null;
    }
  }

  /**
   * Middleware runs at the edge with no database access, so it can only check
   * that the token is well-formed and unexpired. "Is this user banned right
   * now" is enforced in the data layer by requireSession(), which reads live
   * account state on every request. The 15-minute access token TTL bounds how
   * long a just-banned session could otherwise keep reading.
   */
  /**
   * Dev-only preview bypass.
   *
   * The dashboard is behind the session guard, which means it is unreachable
   * until the auth backend is running — inconvenient while building the UI.
   * This lets `campusnotehub_DEV_BYPASS_AUTH=1 npm run dev` render it directly.
   *
   * The NODE_ENV check is the load-bearing half and it is deliberately first:
   * Next.js inlines `process.env.NODE_ENV` as the literal 'production' string
   * in a production build, so this whole branch is dead code that the
   * minifier strips. Setting the variable on a production deploy does nothing.
   */
  const devBypass =
    process.env.NODE_ENV !== 'production' && process.env.campusnotehub_DEV_BYPASS_AUTH === '1';

  /**
   * Applied to the redirect responses as well as the rendered page, because a
   * redirect is itself cacheable and a cached 307 to /dashboard would be just
   * as wrong once the session state changed.
   */
  const noStore = NO_STORE.some((r) => r.test(pathname));
  const harden = (res: NextResponse) => {
    if (!noStore) return res;
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.headers.set('Pragma', 'no-cache');
    res.headers.set('Expires', '0');
    return res;
  };

  if (!session && !devBypass && PROTECTED.some((r) => r.test(pathname))) {
    /**
     * No valid access token. It may simply have expired (its cookie lives as
     * long as the 15-minute token), and the 30-day refresh token is scoped to
     * /api/auth so this middleware cannot see it. Hand the navigation to the
     * refresh route, which can: it comes back here with fresh cookies or goes
     * on to /login. CH_RF, set for a few seconds after a successful refresh,
     * breaks any loop if a fresh token still fails verification here.
     */
    if (process.env.JWT_PUBLIC_KEY_PEM && !request.cookies.get('CH_RF')) {
      const url = new URL('/api/auth/refresh', request.url);
      url.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
      return harden(NextResponse.redirect(url));
    }
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname);
    return harden(NextResponse.redirect(url));
  }

  /**
   * -------------------------------------------------------------------------
   * WHY /login IS NO LONGER REDIRECTED AWAY FROM HERE
   * -------------------------------------------------------------------------
   * This used to bounce any request for /login or /register to /dashboard
   * whenever `session` was non-null - and `session` here means nothing more
   * than "the CH_AT cookie holds a signature we minted that has not expired
   * yet". The edge has no database, so it cannot see `revokedAt`.
   *
   * That is what made signing out look undone. Logging out revokes the row and
   * clears the cookies, but any browser still holding a copy of CH_AT - a
   * restored tab, a synced profile, a second window, a token inside its TTL -
   * would ask for /login and be sent to /dashboard without one credential
   * being checked against live data. From the user's side that is precisely
   * "I opened the login page and it logged me straight back in".
   *
   * The bounce itself is worth keeping, so it moved to the login page, which
   * runs in Node with database access and calls getViewer(): a genuinely live
   * session is still forwarded, a revoked one is sent through /logout to have
   * its cookies cleared, and everyone else gets the form. Same behaviour when
   * the session is real, correct behaviour when it is not.
   */

  // Belt and braces alongside the server-side check: a stolen token must not
  // outlive the ban that revoked its session.
  if (session?.ver === 'BANNED') {
    const url = new URL('/login', request.url);
    url.searchParams.set('reason', 'suspended');
    /**
     * `cookies.delete(name)` expires the cookie at path `/`, which matches
     * CH_AT but NOT CH_RT - that one is stored at /api/auth, so the delete
     * above it was a no-op and left the banned account holding a live refresh
     * token it could spend at /api/auth/refresh. Expired explicitly at the
     * path it was actually written to.
     */
    const redirect = clearAuthCookies(NextResponse.redirect(url));
    return harden(redirect);
  }

  return harden(response);
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
