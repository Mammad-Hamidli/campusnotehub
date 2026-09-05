import az from '../../../messages/az.json';
import en from '../../../messages/en.json';
import ru from '../../../messages/ru.json';

export const LOCALES = ['az', 'en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'az';
export const LOCALE_COOKIE = 'CH_LOCALE';

export const LOCALE_META: Record<Locale, { native: string; short: string; flag: string }> = {
  az: { native: 'Azərbaycanca', short: 'AZ', flag: '🇦🇿' },
  en: { native: 'English', short: 'EN', flag: '🇬🇧' },
  ru: { native: 'Русский', short: 'RU', flag: '🇷🇺' },
};

export type Dictionary = typeof en;

/**
 * All three dictionaries are bundled rather than fetched on switch.
 *
 * They total ~30 KB gzipped, which is cheaper than the round trip plus the
 * layout shift you get from swapping copy asynchronously. Switching language
 * is then instantaneous with no navigation and no flash of the old strings.
 *
 * TRADE-OFF worth knowing before this ships to a public marketing page: the
 * locale lives in a cookie, not the URL, so `/` serves three different
 * languages and search engines will only ever index one of them. For SEO you
 * want `/az`, `/en`, `/ru` prefixes with hreflang tags, which means moving the
 * public pages under an `app/[locale]/` segment and resolving the dictionary
 * per-route on the server. The dashboard and registration flow are noindex
 * anyway and are better served by this instant, navigation-free toggle.
 */
export const DICTIONARIES: Record<Locale, Dictionary> = {
  az: az as Dictionary,
  en,
  ru: ru as Dictionary,
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolves `t('a.b.c')` against a dictionary and interpolates `{name}` tokens.
 * Returns the key path itself when a key is missing, so a gap is visible in
 * the UI during development instead of rendering as an empty element.
 */
export function translate(
  dict: Dictionary,
  key: string,
  params?: Record<string, string | number>,
): string {
  const value = key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);

  if (typeof value !== 'string') {
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  if (!params) return value;

  return value.replace(/\{(\w+)\}/g, (match, token: string) =>
    token in params ? String(params[token]) : match,
  );
}
