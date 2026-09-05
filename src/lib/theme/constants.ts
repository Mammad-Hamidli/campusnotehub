/**
 * Theme constants — deliberately NOT in a 'use client' module.
 *
 * This split exists because of a real bug, and the bug is subtle enough to be
 * worth recording so nobody merges these files back together.
 *
 * These constants originally lived in ThemeProvider.tsx, which carries a
 * 'use client' directive. When a Server Component imports from a client
 * module, the bundler replaces that module with a client-reference proxy —
 * the React components come through fine, but a plain non-component export
 * like a string constant resolves to `undefined` on the server.
 *
 * The result was silent and looked like a CSS problem: the root layout called
 * `cookies().get(THEME_COOKIE)` with `THEME_COOKIE === undefined`, always got
 * back nothing, always fell through to the 'system' default, and always
 * server-rendered `data-theme="light"`. A user with dark mode saved got a
 * white flash on every single navigation, and nothing in the theme CSS was
 * actually wrong.
 *
 * The tell that isolated it: `CH_LOCALE` worked correctly, and its constant
 * lives in dictionaries.ts, which has no 'use client'.
 *
 * Rule of thumb this encodes: any value a Server Component reads must come
 * from a module without 'use client'.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_COOKIE = 'CH_THEME';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Blocking script injected into <head>.
 *
 * Runs before first paint and sets data-theme from the cookie, falling back to
 * the OS media query. It has to be synchronous and inline; anything deferred
 * runs after the first paint, which is exactly the frame that flashes.
 *
 * It also covers the one case SSR cannot: preference 'system'. The OS setting
 * is only knowable in the browser, so the server emits the light token set and
 * this corrects it microseconds later, before anything is painted.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);
var p=m?decodeURIComponent(m[1]):'system';
var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.theme=d?'dark':'light';
}catch(e){document.documentElement.dataset.theme='light';}})();`;
