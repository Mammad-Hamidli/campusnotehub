/**
 * Which build of the desktop app (desktop/, Tauri) is hosting this page, if any.
 *
 * The app loads this same site, and grants it no IPC, so the page cannot ask
 * the shell anything. Instead, from 1.1.0 on the shell defines a frozen global
 * before any page script runs (app_info_script in desktop/src-tauri/src/main.rs),
 * and only on this site's origin. Builds before that define nothing of their
 * own, but Tauri injects __TAURI_INTERNALS__ into every page it hosts, so
 * they are still recognisable as "the app, 1.0.1 or older".
 *
 * Browser-only: the server cannot tell the app from a browser, so callers read
 * this after hydration (useSyncExternalStore with a null server snapshot).
 */

declare global {
  interface Window {
    __CAMPUSNOTEHUB_DESKTOP__?: { readonly version: string };
  }
}

/** GET /api/desktop/release: the newest installer, or null when unknown. */
export type DesktopRelease = { version: string; url: string; sizeBytes: number | null };

/** The newest build that does not report its version. */
export const LEGACY_DESKTOP_VERSION = '1.0.1';

/** The desktop app's version, or null in an ordinary browser. */
export function desktopAppVersion(): string | null {
  const reported = window.__CAMPUSNOTEHUB_DESKTOP__?.version;
  if (typeof reported === 'string' && reported) return reported;
  return '__TAURI_INTERNALS__' in window ? LEGACY_DESKTOP_VERSION : null;
}

export function isDesktopApp(): boolean {
  return desktopAppVersion() !== null;
}

/**
 * True when `candidate` is a later X.Y.Z than `current`. A pre-release or build
 * suffix is ignored, and anything unparseable is never "newer", so a malformed
 * tag cannot put a permanent banner in front of every user.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
