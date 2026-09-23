import { configuredAppOrigin } from '@/lib/app-url';

/**
 * Absolute URL construction for email bodies.
 *
 * Split out of layout.ts so that branding.ts can use it without importing the
 * renderer - layout.ts imports branding.ts, and a mutual import between the
 * two would be a cycle. Every template's links go through this, so a
 * deployment changes its domain by setting APP_URL and nothing else.
 *
 * ABSOLUTE, always. A relative href in an email resolves against the webmail
 * client's own origin (mail.google.com), which is why every link in a message
 * has to carry the scheme and host.
 */
export function appUrl(path = ''): string {
  const base = configuredAppOrigin() ?? 'https://www.campusnotehub.com';
  if (!path) return base;
  return `${base}/${path.replace(/^\/+/, '')}`;
}
