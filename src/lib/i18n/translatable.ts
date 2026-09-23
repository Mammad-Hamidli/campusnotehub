/**
 * The languages a FEED POST can be translated into.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT THE UI LOCALE LIST
 * ---------------------------------------------------------------------------
 * `LOCALES` in ./dictionaries.ts is the set of languages the INTERFACE is
 * translated into - az, en, ru - and every one of them costs a hand-written
 * message bundle that a human has to maintain and that scripts/check-i18n.mjs
 * enforces. Adding a language there is a project.
 *
 * This list is the set of languages a post's BODY can be machine-translated
 * into on demand. It costs nothing but an API call, so it is wider, and the
 * two lists move independently on purpose: a Chinese exchange student reads
 * the interface in English and the posts in Chinese.
 *
 * ---------------------------------------------------------------------------
 * "ch" IS NOT A LANGUAGE CODE
 * ---------------------------------------------------------------------------
 * Chinese is `zh` in BCP-47 and in every translation API; `ch` is Chamorro.
 * The canonical code used on the wire and in the cache is therefore `zh`, and
 * `ch` is accepted as an ALIAS (see normalizeTargetLang) because it is what
 * people type and what the feature was specified as. Sending `ch` to the
 * provider would silently return untranslated text.
 *
 * This module is imported by client components, so it must stay free of
 * server-only imports and of anything heavy.
 */

export const TRANSLATION_TARGETS = ['az', 'en', 'ru', 'zh', 'ar', 'de'] as const;

export type TargetLang = (typeof TRANSLATION_TARGETS)[number];

/**
 * Display metadata. `native` is deliberately in the target language itself -
 * someone looking for Arabic scans for العربية, not for "Arabic" spelled in a
 * language they do not read.
 *
 * `dir` drives the `dir` attribute on the rendered paragraph. Without it an
 * Arabic translation renders left-aligned with its punctuation at the wrong
 * end, which is the one rendering bug that makes the feature look broken to
 * exactly the users it was added for.
 */
export const TARGET_META: Record<
  TargetLang,
  { native: string; short: string; flag: string; dir: 'ltr' | 'rtl' }
> = {
  az: { native: 'Azərbaycanca', short: 'AZ', flag: '🇦🇿', dir: 'ltr' },
  en: { native: 'English', short: 'EN', flag: '🇬🇧', dir: 'ltr' },
  ru: { native: 'Русский', short: 'RU', flag: '🇷🇺', dir: 'ltr' },
  zh: { native: '中文', short: 'ZH', flag: '🇨🇳', dir: 'ltr' },
  ar: { native: 'العربية', short: 'AR', flag: '🇸🇦', dir: 'rtl' },
  de: { native: 'Deutsch', short: 'DE', flag: '🇩🇪', dir: 'ltr' },
};

/** Aliases accepted from a caller and folded onto the canonical code. */
const ALIASES: Record<string, TargetLang> = {
  ch: 'zh',
  'zh-cn': 'zh',
  'zh-hans': 'zh',
  aze: 'az',
  rus: 'ru',
  ara: 'ar',
  ger: 'de',
  deu: 'de',
};

/**
 * Folds any reasonable spelling of a language onto a supported target, or
 * returns null. Case- and region-insensitive: a browser sends `de-AT`, a
 * stored profile locale may be `en-GB`, and both mean a language we have.
 */
export function normalizeTargetLang(value: unknown): TargetLang | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;

  if ((TRANSLATION_TARGETS as readonly string[]).includes(lower)) return lower as TargetLang;
  if (lower in ALIASES) return ALIASES[lower];

  const base = lower.split(/[-_]/)[0];
  if ((TRANSLATION_TARGETS as readonly string[]).includes(base)) return base as TargetLang;
  return ALIASES[base] ?? null;
}

export function isTargetLang(value: unknown): value is TargetLang {
  return typeof value === 'string' && (TRANSLATION_TARGETS as readonly string[]).includes(value);
}
