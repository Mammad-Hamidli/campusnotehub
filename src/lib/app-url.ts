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
 * The origin a request-bound flow (OAuth redirect URI, post-login redirect)
 * must come back to.
 *
 * APP_URL, except for a loopback request outside production. `.env` carries
 * the production APP_URL, so without this exception every local "Continue
 * with Google" was sent to https://www.campusnotehub.com (or given it as the
 * redirect URI) - a different host from the one holding the CH_OAUTH binding
 * cookie, so the flow could never complete. Only loopback hosts qualify, so a
 * spoofed Host header still cannot steer where codes are sent.
 */
export function flowOrigin(requestOrigin: string): string | null {
  if (process.env.NODE_ENV !== 'production') {
    try {
      const url = new URL(requestOrigin);
      if (LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
    } catch {
      // Not a URL: fall through to APP_URL.
    }
  }
  return configuredAppOrigin();
}

/**
 * The origin as the BROWSER addressed it: forwarded/Host headers first, then
 * nextUrl. `next dev` reports nextUrl as localhost:3000 even for a request to
 * 127.0.0.1:3000, and a proxy can make it read http:// or an internal host, so
 * nextUrl alone mismatched the host the CH_OAUTH cookie is set on.
 *
 * Header-derived, so only ever fed to flowOrigin(), which ignores it outside
 * loopback-in-development.
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
