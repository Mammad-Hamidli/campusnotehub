'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALE_COOKIE,
  translate,
  type Dictionary,
  type Locale,
} from './dictionaries';

type LocaleContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  dict: Dictionary;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Language state for the whole app.
 *
 * The initial locale is resolved on the SERVER from the CH_LOCALE cookie and
 * passed in, so the first paint is already in the right language. This matters
 * more than it sounds: a client-only toggle renders Azerbaijani, hydrates, then
 * repaints in Russian, and the flash is very visible on the landing page's
 * large headline.
 *
 * Switching afterwards is pure client state - no navigation, no refetch.
 * The cookie write is what makes the choice survive a reload and reach the
 * server on the next request.
 */
export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);

    // 1 year, lax so it survives the OAuth-style returns and email links the
    // auth flow uses. Not httpOnly on purpose - this is a display preference,
    // and the client needs to read it before hydration in edge cases.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;

    // Keeps screen readers and the browser's own translation prompt honest.
    document.documentElement.lang = next;

    // Signed-in users get the choice persisted to their profile too, so it
    // follows them to another device and is used for their email notifications.
    // Fire-and-forget: a failed write must never block the UI switch.
    void fetch('/api/me/locale', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: next }),
    }).catch(() => {});
  }, []);

  const value = useMemo<LocaleContextValue>(() => {
    const dict = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
    return {
      locale,
      setLocale,
      dict,
      t: (key, params) => translate(dict, key, params),
    };
  }, [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>');
  return ctx;
}

/** Shorthand for the common case where only the translator is needed. */
export function useT() {
  return useLocale().t;
}
