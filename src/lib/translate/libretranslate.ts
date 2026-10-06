import 'server-only';
import { normalizeTargetLang, type TargetLang } from '@/lib/i18n/translatable';
import { TranslationError } from './errors';
import { detectSourceLang, restoreAzSpelling } from './source';

/**
 * Post translation through LibreTranslate - the public service at
 * libretranslate.com or any self-hosted instance - called from the SERVER only
 * (src/app/api/translate/route.ts is the one caller).
 *
 *   POST <LIBRETRANSLATE_URL>/translate
 *   { q: string[], source: "az" | "auto" | ..., target, format: "text", api_key? }
 *   -> { translatedText: string[], detectedLanguage?: [{ language, confidence }, ...] }
 *
 * Server-side on purpose: an instance may require an API key (libretranslate.com
 * always does), and a key in the browser bundle is a key anyone can read and
 * spend. It also makes the instance a runtime setting rather than something
 * baked into the build, and keeps the page's CSP at connect-src 'self'.
 *
 * <source> comes from detectSourceLang() (./source.ts) and is `auto` only when
 * the text does not say: statistical detection misreads short casual
 * Azerbaijani, which is most of what a campus feed holds.
 *
 * Quirks of the API that shape this module (from LibreTranslate's own source):
 *   - Errors are `{ "error": "<sentence>" }`. A MISSING key is a 400 ("... to
 *     get an API key"), a WRONG one a 403, the instance's own limiter a 429.
 *     So a 400 is told apart by its message, not just its status.
 *   - `detectedLanguage` is present only when the source is `auto`, and for a
 *     batch it is ONE detection over every piece, repeated per piece.
 *   - An instance may cap the characters per piece (--char-limit; self-hosted
 *     defaults to no cap, public ones do not), hence the splitting below.
 *   - Codes come back ISO-style - Chinese is "zh-Hans" - so they are folded
 *     through normalizeTargetLang before being compared with the target.
 */

export type LibreTranslateConfig = {
  /** The full /translate URL. */
  endpoint: string;
  apiKey: string | null;
};

/**
 * LIBRETRANSLATE_URL is the instance's BASE url - https://libretranslate.com,
 * http://localhost:5000, https://example.org/lt - and the /translate endpoint
 * itself is accepted too. Returns null when unset or not an http(s) URL, which
 * the route reports to the reader as "unavailable".
 */
export function libreTranslateConfig(
  env: Record<string, string | undefined> = process.env,
): LibreTranslateConfig | null {
  const raw = env.LIBRETRANSLATE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '').replace(/\/translate$/, '');
  return { endpoint: `${base}/translate`, apiKey: env.LIBRETRANSLATE_API_KEY?.trim() || null };
}

/** Well under any public instance's per-piece cap, and a few sentences of context each. */
const MAX_PIECE = 1000;
/** Per request. A reply can be two requests (see bestTranslation), inside a function's time budget. */
const TIMEOUT_MS = 8_000;

/** One request's worth of text, with the whitespace around it kept aside. */
export type Piece = { lead: string; text: string; trail: string };

/**
 * Splits text into pieces of at most `max` characters. Sentences stay whole
 * where possible; an overlong one is cut at a space. Concatenating
 * lead + text + trail over the pieces reproduces the input exactly, which is
 * what lets the translation keep the post's paragraphs.
 */
export function splitForTranslation(text: string, max = MAX_PIECE): Piece[] {
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

/** Share of the source's words (3+ letters) that came back untouched - the provider gave up on them. */
export function echoRatio(source: string, output: string): number {
  const words = (value: string) => value.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const original = words(source);
  if (!original.length) return 0;
  const kept = new Set(words(output));
  return original.filter((word) => kept.has(word)).length / original.length;
}

/**
 * A 400 about the LANGUAGE - not installed on this instance, or no model for
 * the pair. The one failure a different source can fix, so the caller may
 * retry with `auto`; to the reader it is still just "failed".
 */
class PairUnavailable extends TranslationError {
  constructor() {
    super('failed');
  }
}

type BatchResult = { texts: string[]; sameLanguage: boolean };

/** LibreTranslate's error body, folded onto what the reader is told. */
function providerError(status: number, message: string, target: TargetLang): TranslationError | BatchResult {
  if (status === 429) return new TranslationError('quota');
  if (status === 403 || (status === 400 && /api key/i.test(message))) {
    // The deployment's fault, not the reader's: say so where an operator looks.
    console.error(`[translate] LibreTranslate refused the API key (${status}): ${message}`);
    return new TranslationError('unavailable');
  }
  if (status === 400 && /not available as a target language|is not supported/i.test(message)) {
    // "<target> is not available as a target language from <name> (<code>)":
    // detection landed on the target itself and the instance has no identity
    // model for it. That is a same-language answer, not a failure.
    const from = /from .*\(([\w-]+)\)\s*$/.exec(message)?.[1];
    if (normalizeTargetLang(from) === target) return { texts: [], sameLanguage: true };
    return new PairUnavailable();
  }
  console.warn(`[translate] LibreTranslate answered ${status}: ${message || '(no message)'}`);
  return new TranslationError(status >= 502 ? 'unavailable' : 'failed');
}

async function requestBatch(
  config: LibreTranslateConfig,
  q: string[],
  source: string,
  target: TargetLang,
): Promise<BatchResult> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        q,
        source,
        target,
        format: 'text',
        ...(config.apiKey ? { api_key: config.apiKey } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new TranslationError('unavailable');
  }

  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    translatedText?: unknown;
    detectedLanguage?: { language?: unknown } | { language?: unknown }[];
  } | null;

  if (!response.ok) {
    const outcome = providerError(response.status, typeof body?.error === 'string' ? body.error : '', target);
    if (outcome instanceof TranslationError) throw outcome;
    return outcome;
  }

  const texts = body?.translatedText;
  if (
    !Array.isArray(texts) ||
    texts.length !== q.length ||
    texts.some((text) => typeof text !== 'string' || !text.trim())
  ) {
    throw new TranslationError('failed');
  }
  const detected = Array.isArray(body?.detectedLanguage) ? body.detectedLanguage[0] : body?.detectedLanguage;
  return {
    texts: texts as string[],
    sameLanguage: source === 'auto' && normalizeTargetLang(detected?.language) === target,
  };
}

/**
 * The pieces, from a known source language when there is one.
 *
 * A detected source that the provider still mostly echoes back (mixed or
 * unusual text) gets ONE second opinion from `auto`, and whichever answer
 * translated more of the words wins - so detection can only improve on plain
 * `auto`, never lose a translation it would have got. The same second opinion
 * covers an instance that has no model for the detected language.
 */
async function bestTranslation(
  config: LibreTranslateConfig,
  q: string[],
  source: string | null,
  target: TargetLang,
): Promise<BatchResult> {
  if (!source) return requestBatch(config, q, 'auto', target);

  let first: BatchResult;
  try {
    first = await requestBatch(config, source === 'az' ? q.map(restoreAzSpelling) : q, source, target);
  } catch (error) {
    if (error instanceof PairUnavailable) return requestBatch(config, q, 'auto', target);
    throw error;
  }
  const original = q.join('\n');
  const firstEcho = echoRatio(original, first.texts.join('\n'));
  if (firstEcho <= 0.5) return first;

  const second = await requestBatch(config, q, 'auto', target).catch(() => first);
  return !second.sameLanguage && echoRatio(original, second.texts.join('\n')) < firstEcho ? second : first;
}

/**
 * Recent answers, per warm server instance. Every reader of a popular post
 * now shares one provider (they each had their own quota when the browser
 * called it), so the second reader asking for the same language should not
 * cost the instance another translation. Bounded; oldest entry goes first.
 */
const recent = new Map<string, string>();
const RECENT_MAX = 500;

/**
 * Translates `text` into `target`: one request for all pieces, two when the
 * first answer needs a second opinion. Throws TranslationError; `sameLanguage`
 * when the provider found the text already in the target language.
 */
export async function translatePost(
  text: string,
  target: TargetLang,
  config: LibreTranslateConfig,
): Promise<string> {
  const source = text.trim();
  if (!source) throw new TranslationError('empty');

  const key = `${target}\u0000${source}`;
  const hit = recent.get(key);
  if (hit !== undefined) return hit;

  // Detected once over the whole post - more words, better evidence - and
  // never equal to the target: then the provider decides whether it really is
  // the same language, so a wrong guess cannot block a translation.
  const detected = detectSourceLang(source);
  const from = detected === target ? null : detected;

  const pieces = splitForTranslation(source);
  const q = pieces.map((piece) => piece.text).filter(Boolean);
  const result = await bestTranslation(config, q, from, target);
  if (result.sameLanguage) throw new TranslationError('sameLanguage');

  let next = 0;
  const joined = pieces.map((piece) => piece.lead + (piece.text ? result.texts[next++] : '') + piece.trail).join('');

  if (recent.size >= RECENT_MAX) recent.delete(recent.keys().next().value!);
  recent.set(key, joined);
  return joined;
}
