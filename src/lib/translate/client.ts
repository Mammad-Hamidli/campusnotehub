import type { TargetLang } from '@/lib/i18n/translatable';
import { TranslationError, translationErrorCode, type TranslationErrorCode } from './errors';

/**
 * The browser half of post translation: one POST to /api/translate per post
 * and language, cached for the life of the tab.
 *
 * Which service answers, where it lives and whether it needs a key are the
 * server's business (./libretranslate.ts) - nothing here names a provider, so
 * swapping one is a server change and a redeploy, never a client release.
 *
 * Only text the reader can already see is ever sent, and only when they press
 * Translate on that post.
 */

const ENDPOINT = '/api/translate';

/** Text -> translation, per target, for the life of the tab. */
const cache = new Map<string, string>();

/** For a reply with no usable `{ error }` key: a proxy's HTML page, a cold-start timeout. */
function codeForStatus(status: number): TranslationErrorCode {
  if (status === 429) return 'quota';
  return status >= 500 ? 'unavailable' : 'failed';
}

/**
 * Translates `text` into `target`. Throws TranslationError with a locale key;
 * `sameLanguage` when the post is already in the target language. An aborted
 * `signal` rethrows the AbortError unchanged.
 */
export async function translateText(text: string, target: TargetLang, signal?: AbortSignal): Promise<string> {
  const source = text.trim();
  if (!source) throw new TranslationError('empty');

  const key = `${target}\u0000${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: source, target }),
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new TranslationError('unavailable');
  }

  const body = (await response.json().catch(() => null)) as { translation?: unknown; error?: unknown } | null;
  const translation = body?.translation;
  if (response.ok && typeof translation === 'string' && translation.trim()) {
    cache.set(key, translation);
    return translation;
  }
  throw new TranslationError(translationErrorCode(body?.error) ?? codeForStatus(response.status));
}
