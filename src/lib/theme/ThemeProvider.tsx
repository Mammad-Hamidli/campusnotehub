'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { THEME_COOKIE, type ResolvedTheme, type ThemePreference } from './constants';

// Re-exported for client components that already import from here. The values
// themselves MUST live in constants.ts - see the comment in that file for the
// server-import bug this split fixes.
export { THEME_COOKIE, THEME_INIT_SCRIPT, isThemePreference } from './constants';
export type { ThemePreference, ResolvedTheme } from './constants';

type ThemeContextValue = {
  /** What the user chose. Can be 'system'. */
  preference: ThemePreference;
  /** What is actually painted. Never 'system'. */
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Three-way theme: light / dark / system.
 *
 * The distinction that makes this correct rather than merely working:
 * `preference` and `resolved` are different values. 'system' is a stored
 * preference, never a value on the DOM — `<html>` always carries a concrete
 * `data-theme` of "light" or "dark", so every CSS selector stays a simple
 * attribute match instead of being duplicated under a media query.
 *
 * When the preference is 'system' we subscribe to the OS media query and
 * re-resolve live, so changing the OS appearance updates an open tab without
 * a reload. Most implementations read the media query once at mount and
 * silently stop tracking; that is the bug this avoids.
 */
export function ThemeProvider({
  initialPreference,
  children,
}: {
  initialPreference: ThemePreference;
  children: ReactNode;
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(
    initialPreference === 'dark' ? 'dark' : 'light',
  );

  // Resolve, and keep resolving while the preference is 'system'.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const next: ResolvedTheme =
        preference === 'system' ? (query.matches ? 'dark' : 'light') : preference;
      setResolved(next);
      document.documentElement.dataset.theme = next;
    };

    apply();
    if (preference !== 'system') return;

    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    // Readable by the server on the next request so SSR paints the right theme.
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
