/**
 * The canonical public origin, from APP_URL.
 *
 * Normalised through URL so every consumer gets byte-identical output:
 * lower-cased host, no trailing slash, no path, no default port. The OAuth
 * redirect URI in particular must match the one registered with Google
 * exactly - `https://www.campusnotehub.com/` or `:443` would be a mismatch.
 *
 * Returns null when APP_URL is unset or unparseable; callers decide the
 * fallback (the request's own origin in development).
 */
export function configuredAppOrigin(): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The request's origin when it is a loopback host outside production, else
 * null. Only loopback qualifies, so a spoofed Host header still cannot steer
 * where codes or redirects are sent.
 */
function devLoopback(requestOrigin: string): URL | null {
  if (process.env.NODE_ENV === 'production') return null;
  try {
    const url = new URL(requestOrigin);
    return LOOPBACK_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * The origin an OAuth flow runs on: its redirect URI, and the host the start
 * route hops to before setting the CH_OAUTH binding cookie.
 *
 * APP_URL, except for a loopback request outside production. `.env` carries
 * the production APP_URL, so without this exception every local "Continue
 * with Google" was sent to https://www.campusnotehub.com (or given it as the
 * redirect URI) - a different host from the one holding the binding cookie,
 * so the flow could never complete.
 *
 * Every loopback host becomes `localhost` (port kept): Google accepts
 * http://localhost:3000 as a redirect URI but rejects http://127.0.0.1:3000
 * with redirect_uri_mismatch, so one host must own the whole flow.
 */
export function flowOrigin(requestOrigin: string): string | null {
  const url = devLoopback(requestOrigin);
  if (!url) return configuredAppOrigin();
  url.hostname = 'localhost';
  return url.origin;
}

/**
 * The origin for a redirect that sets cookies on the same response (session
 * after login, OAuth outcomes). Like flowOrigin, but a loopback host is KEPT:
 * cookies are host-only, so a session set on 127.0.0.1 and redirected to
 * localhost would arrive signed out.
 */
export function sameHostOrigin(requestOrigin: string): string | null {
  return devLoopback(requestOrigin)?.origin ?? configuredAppOrigin();
}

/**
 * The origin as the BROWSER addressed it: forwarded/Host headers first, then
 * nextUrl. `next dev` reports nextUrl as localhost:3000 even for a request to
 * 127.0.0.1:3000, and a proxy can make it read http:// or an internal host, so
 * nextUrl alone mismatched the host the CH_OAUTH cookie is set on.
 *
 * Header-derived, so only ever fed to flowOrigin() or sameHostOrigin(), which
 * ignore it outside loopback-in-development.
 */
export function browserOrigin(request: { headers: Headers; nextUrl: URL }): string {
  const first = (name: string) => request.headers.get(name)?.split(',')[0].trim() || null;
  const host = (first('x-forwarded-host') ?? first('host') ?? request.nextUrl.host).toLowerCase();
  const proto = first('x-forwarded-proto') ?? request.nextUrl.protocol.replace(/:$/, '');
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return request.nextUrl.origin;
  }
}
