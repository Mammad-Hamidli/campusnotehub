import type { TargetLang } from '@/lib/i18n/translatable';
import { detectSourceLang, restoreAzSpelling } from './source';

/**
 * Post translation through MyMemory's free API, called from the BROWSER.
 *
 *   GET https://api.mymemory.translated.net/get?q=<text>&langpair=<source>|<target>
 *
 * <source> comes from detectSourceLang() (./source.ts) and is `autodetect`
 * only when the text does not say: the provider's own guess mistakes short
 * casual Azerbaijani for Indonesian ("salam dostum" -> "salutation dostum").
 *
 * Client-side on purpose: there is no key, no billing and nothing to cache
 * server-side, and the free quota is counted per caller address - so each
 * reader spends their own allowance instead of the whole campus sharing one
 * server IP's. The origin is allowed in the CSP's connect-src (middleware.ts).
 *
 * Only text the reader can already see is ever sent, and only when they press
 * Translate on that post.
 *
 * Three quirks of the API shape this module:
 *   - Failures arrive as HTTP 200 with `responseStatus: "403"` (a string) and
 *     the reason in `responseDetails`, so the status in the BODY is what counts.
 *   - A query is capped at 500 characters, so longer posts are split at
 *     sentence boundaries and the pieces reassembled with their original
 *     whitespace.
 *   - Text already in the target language answers "PLEASE SELECT TWO DISTINCT
 *     LANGUAGES", which is a result, not an error.
 */

const ENDPOINT = 'https://api.mymemory.translated.net/get';
/** Below the 500-character cap, leaving room for multi-unit characters. */
const MAX_CHUNK = 450;

export class TranslationError extends Error {
  constructor(readonly messageKey: string) {
    super(messageKey);
  }
}

/** Text -> translation, per target, for the life of the tab. */
const cache = new Map<string, string>();

/** One request's worth of text, with the whitespace around it kept aside. */
export type Piece = { lead: string; text: string; trail: string };

/**
 * Splits text into pieces of at most `max` characters. Sentences stay whole
 * where possible; an overlong one is cut at a space. Concatenating
 * lead + text + trail over the pieces reproduces the input exactly, which is
 * what lets the translation keep the post's paragraphs.
 */
export function splitForTranslation(text: string, max = MAX_CHUNK): Piece[] {
  const chunks: string[] = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?\n])/)) {
    if (current && current.length + sentence.length > max) {
      chunks.push(current);
      current = '';
    }
    let rest = sentence;
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max);
      const at = cut > 0 ? cut : max;
      chunks.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    current += rest;
  }
  if (current) chunks.push(current);

  return chunks.map((chunk) => {
    const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(chunk)!;
    return { lead, text: body, trail };
  });
}

/** MyMemory returns HTML entities (&#39;, &quot;); a detached textarea decodes them inertly. */
function decodeEntities(value: string): string {
  if (!value.includes('&') || typeof document === 'undefined') return value;
  const area = document.createElement('textarea');
  area.innerHTML = value;
  return area.value;
}

type ChunkResult = { text: string; sameLanguage: boolean };

async function requestChunk(q: string, source: string, target: TargetLang, signal?: AbortSignal): Promise<ChunkResult> {
  const url = `${ENDPOINT}?${new URLSearchParams({ q, langpair: `${source}|${target}` })}`;
  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new TranslationError('feed.translate.errors.unavailable');
  }
  if (response.status === 429) throw new TranslationError('feed.translate.errors.quota');
  if (!response.ok) throw new TranslationError('feed.translate.errors.unavailable');

  const body = (await response.json().catch(() => null)) as {
    responseStatus?: number | string;
    responseDetails?: string;
    quotaFinished?: boolean | null;
    responseData?: { translatedText?: string };
  } | null;

  const details = String(body?.responseDetails ?? '');
  if (/DISTINCT LANGUAGES/i.test(details)) return { text: q, sameLanguage: true };
  if (body?.quotaFinished || /QUOTA|LIMIT REACHED/i.test(details)) {
    throw new TranslationError('feed.translate.errors.quota');
  }
  const translated = body?.responseData?.translatedText;
  if (Number(body?.responseStatus) !== 200 || typeof translated !== 'string' || !translated.trim()) {
    throw new TranslationError('feed.translate.errors.failed');
  }
  return { text: decodeEntities(translated), sameLanguage: false };
}

/** Share of the source's words (3+ letters) that came back untouched - the provider gave up on them. */
export function echoRatio(source: string, output: string): number {
  const words = (value: string) => value.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const original = words(source);
  if (!original.length) return 0;
  const kept = new Set(words(output));
  return original.filter((word) => kept.has(word)).length / original.length;
}

/**
 * One piece, from a known source language when there is one.
 *
 * A detected source that the provider still mostly echoes back (mixed or
 * unusual text) gets ONE second opinion from autodetect, and whichever answer
 * translated more of the words wins - so detection can only improve on the
 * old behaviour, never lose a translation it used to get.
 */
async function translateChunk(
  q: string,
  source: string | null,
  target: TargetLang,
  signal?: AbortSignal,
): Promise<ChunkResult> {
  if (!q.trim()) return { text: q, sameLanguage: true };
  if (!source) return requestChunk(q, 'autodetect', target, signal);

  const first = await requestChunk(source === 'az' ? restoreAzSpelling(q) : q, source, target, signal);
  if (first.sameLanguage || echoRatio(q, first.text) <= 0.5) return first;

  const second = await requestChunk(q, 'autodetect', target, signal).catch((error: unknown) => {
    if ((error as Error)?.name === 'AbortError') throw error;
    return first;
  });
  return !second.sameLanguage && echoRatio(q, second.text) < echoRatio(q, first.text) ? second : first;
}

/**
 * Translates `text` into `target`, one request per piece, in parallel.
 * Throws TranslationError with a locale key; `sameLanguage` when every piece
 * was already in the target language.
 */
export async function translateText(text: string, target: TargetLang, signal?: AbortSignal): Promise<string> {
  const source = text.trim();
  if (!source) throw new TranslationError('feed.translate.errors.empty');

  const key = `${target}\u0000${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  // Detected once over the whole post - more words, better evidence - and
  // never equal to the target: then the provider decides whether it really is
  // the same language, so a wrong guess cannot block a translation.
  const detected = detectSourceLang(source);
  const from = detected === target ? null : detected;

  const pieces = splitForTranslation(source);
  const results = await Promise.all(pieces.map((piece) => translateChunk(piece.text, from, target, signal)));
  if (results.every((result) => result.sameLanguage)) {
    throw new TranslationError('feed.translate.errors.sameLanguage');
  }

  const joined = results.map((result, i) => pieces[i].lead + result.text + pieces[i].trail).join('');
  cache.set(key, joined);
  return joined;
}
