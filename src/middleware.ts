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
  /^\/(dashboard|wallet|settings|notifications)/,
  /^\/notes\/(new|purchases)/,
  // Role is re-checked against live DB state in every /api/admin handler; the
  // middleware only guarantees "signed in", because it has no DB access.
  /^\/admin/,
];
/** Routes a signed-in user should be bounced away from. */
const GUEST_ONLY = [/^\/(login|register)$/];

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
    `https://*.s3.eu-central-1.amazonaws.com`,
    `wss://campushub.az`,
    // The dev server pushes hot updates over a plain-ws connection to
    // localhost, which 'self' does not cover once a scheme is involved.
    ...(isDev ? [`ws:`] : []),
  ].join(' ');

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`, // Tailwind emits inline styles for animations
    `img-src 'self' data: blob: https://cdn.campushub.az`,
    `media-src 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    `frame-src 'self' https://meet.campushub.az`,
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
        issuer: 'campushub',
        audience: 'campushub-web',
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
   * This lets `CAMPUSHUB_DEV_BYPASS_AUTH=1 npm run dev` render it directly.
   *
   * The NODE_ENV check is the load-bearing half and it is deliberately first:
   * Next.js inlines `process.env.NODE_ENV` as the literal 'production' string
   * in a production build, so this whole branch is dead code that the
   * minifier strips. Setting the variable on a production deploy does nothing.
   */
  const devBypass =
    process.env.NODE_ENV !== 'production' && process.env.CAMPUSHUB_DEV_BYPASS_AUTH === '1';

  if (!session && !devBypass && PROTECTED.some((r) => r.test(pathname))) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (session && GUEST_ONLY.some((r) => r.test(pathname))) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  // Belt and braces alongside the server-side check: a stolen token must not
  // outlive the ban that revoked its session.
  if (session?.ver === 'BANNED') {
    const url = new URL('/login', request.url);
    url.searchParams.set('reason', 'suspended');
    const redirect = NextResponse.redirect(url);
    redirect.cookies.delete('CH_AT');
    redirect.cookies.delete('CH_RT');
    return redirect;
  }

  return response;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
