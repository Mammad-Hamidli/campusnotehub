/**
 * Where an imported profile photo may be fetched from.
 *
 * The URL arrives in a Google id_token, so it is Google-asserted - but the
 * server is about to make an outbound request to it, and "whatever URL a
 * token carried" is the textbook server-side request forgery shape. So the
 * rule is a closed allowlist rather than a blocklist of private ranges:
 * https, the default port, no userinfo, and a host under googleusercontent.com
 * (where Google serves account photos). Anything else is not fetched at all.
 *
 * Pure, and free of server-only imports, so it is unit-testable.
 */

const ALLOWED_HOST_SUFFIX = '.googleusercontent.com';
const MAX_URL_LENGTH = 2048;

export function avatarSourceUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // WHATWG URL drops the scheme's default port, so any port left is not 443.
  if (url.port) return null;
  if (!url.hostname.endsWith(ALLOWED_HOST_SUFFIX)) return null;
  return url;
}

/**
 * Google serves the photo at the size named at the end of its path ("=s96-c":
 * 96px, cropped square). Asking for the stored size instead means the saved
 * copy is not an upscaled thumbnail. A path without that suffix is unchanged.
 */
export function withPhotoSize(url: URL, size: number): URL {
  const next = new URL(url);
  next.pathname = next.pathname.replace(/=s\d+(-c)?$/, `=s${size}-c`);
  return next;
}
