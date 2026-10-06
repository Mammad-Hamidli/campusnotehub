/**
 * How a post translation can fail, shared by the browser (./client.ts) and the
 * server (./libretranslate.ts, /api/translate). Browser-safe, no imports.
 *
 * Every failure is one of these codes and reaches the reader as the locale key
 * feed.translate.errors.<code>, so the same key travels unchanged from the
 * provider's answer, through the API's `{ error }` body, to the card.
 */

const PREFIX = 'feed.translate.errors.';

export const TRANSLATION_ERROR_CODES = ['failed', 'unavailable', 'empty', 'quota', 'sameLanguage'] as const;

export type TranslationErrorCode = (typeof TRANSLATION_ERROR_CODES)[number];

export class TranslationError extends Error {
  constructor(readonly code: TranslationErrorCode) {
    super(`${PREFIX}${code}`);
  }

  /** The locale key the reader sees. */
  get messageKey(): string {
    return `${PREFIX}${this.code}`;
  }
}

/** The code inside a locale key from the API, or null for anything that is not one. */
export function translationErrorCode(key: unknown): TranslationErrorCode | null {
  if (typeof key !== 'string' || !key.startsWith(PREFIX)) return null;
  const code = key.slice(PREFIX.length);
  return (TRANSLATION_ERROR_CODES as readonly string[]).includes(code) ? (code as TranslationErrorCode) : null;
}
