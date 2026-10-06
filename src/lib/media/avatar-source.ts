/**
 * Where an imported profile photo may be fetched from, and which accounts
 * receive one.
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
 * The provider photo to copy onto an EXISTING account at a provider sign-in
 * or link - as a vetted URL string - or null when that account gets none.
 *
 * A new account gets its copy at creation (quick-signup.ts). An account made
 * any other way - a password signup, a bootstrapped admin - never had that
 * moment, so it gets the same one-time copy here, on the same terms:
 *  - no picture now, and the owner never removed one (`avatarRemovedAt`);
 *  - NOT created by a provider sign-in: those carry `profileIncomplete`
 *    (true or false) and already had their one import. With no picture now,
 *    their owner may have removed it before removals were recorded, and that
 *    choice stands;
 *  - the URL passes the allowlist above. Only this vetted form travels on -
 *    through a 2FA login ticket only sealed (see mfa.ts).
 */
export function providerAvatarFor(
  user: { avatarUrl: string | null; avatarRemovedAt?: Date | null; profileIncomplete?: boolean },
  picture: unknown,
): string | null {
  if (user.avatarUrl || user.avatarRemovedAt || typeof user.profileIncomplete === 'boolean') return null;
  return avatarSourceUrl(picture)?.href ?? null;
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
