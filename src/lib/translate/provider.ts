import 'server-only';
import { adminApp } from '@/lib/firebase/admin';
import type { TargetLang } from '@/lib/i18n/translatable';

/**
 * Machine translation, against Google Cloud Translation v2.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PROVIDER AND NOT A NEW DEPENDENCY
 * ---------------------------------------------------------------------------
 * The deployment already holds a GCP service account for Firebase, in the same
 * project. Enabling the Cloud Translation API on that project is a console
 * toggle and a role grant - no new vendor, no new secret store entry, no new
 * npm package (`@google-cloud/translate` pulls in its own gax/grpc stack, and
 * this file is one fetch).
 *
 * Two credential paths, in order:
 *
 *   1. GOOGLE_TRANSLATE_API_KEY - a restricted API key. Simplest to operate
 *      and the one to use first. It MUST be restricted in the console to the
 *      Cloud Translation API, because an unrestricted key is a key to the
 *      whole project.
 *   2. The Firebase service account, via the access token firebase-admin
 *      already mints. Its credential carries the `cloud-platform` scope, which
 *      covers Translation, so nothing extra is configured beyond granting the
 *      service account `roles/cloudtranslate.user`.
 *
 * Neither variable may be NEXT_PUBLIC_: translating in the browser would put
 * a billable key in the bundle and let anyone drain the quota.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT TRANSLATE IN THE BROWSER AT ALL
 * ---------------------------------------------------------------------------
 * Besides the key: a post's body is only visible to viewers who pass the
 * audience check (src/lib/feed/visibility.ts). Sending it from the client
 * would mean the text has already left the server, so a client-side translator
 * cannot be gated by that check. The route calls findVisiblePost first,
 * precisely so a UNIVERSITY_ONLY post cannot be read through the translate
 * endpoint by anyone who could not read it through the feed.
 */

const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

/** Matches the post body ceiling in POST /api/feed; a guard, not a policy. */
export const MAX_TRANSLATE_CHARS = 2000;

export class TranslationUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'TranslationUnavailableError';
  }
}

export function translationConfigured(): boolean {
  return Boolean(process.env.GOOGLE_TRANSLATE_API_KEY || process.env.FIREBASE_SERVICE_ACCOUNT);
}

/**
 * An OAuth access token from the Firebase service account.
 *
 * firebase-admin caches and refreshes this internally, so calling it per
 * request costs a property read once the first token is minted, not a token
 * exchange.
 */
async function serviceAccountToken(): Promise<string | null> {
  try {
    const credential = adminApp().options.credential;
    const token = await credential?.getAccessToken();
    return token?.access_token ?? null;
  } catch {
    return null;
  }
}

export type TranslationResult = {
  text: string;
  /** The language the provider detected, BCP-47, or null if it did not say. */
  detectedSourceLang: string | null;
};

/**
 * Translates one body. Returns the provider's text verbatim - no trimming, no
 * re-sanitising: the input was already plain text (toPlainText at post time),
 * and the output is rendered as a text node, never as HTML.
 */
export async function translateText(
  text: string,
  target: TargetLang,
): Promise<TranslationResult> {
  if (text.length > MAX_TRANSLATE_CHARS) {
    throw new TranslationUnavailableError('Text exceeds the translation limit');
  }

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  const url = apiKey ? `${ENDPOINT}?key=${encodeURIComponent(apiKey)}` : ENDPOINT;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!apiKey) {
    const token = await serviceAccountToken();
    if (!token) {
      throw new TranslationUnavailableError(
        'Translation is not configured: set GOOGLE_TRANSLATE_API_KEY or provide a service account',
      );
    }
    headers.authorization = `Bearer ${token}`;
    // v2 bills against the caller's project; with a service account the
    // project has to be named explicitly.
    const project = process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (project) headers['x-goog-user-project'] = project;
  }

  /**
   * `format: 'text'`, not 'html'. With 'html' the provider parses the body as
   * markup, and a post containing `<3` or a bare `<` comes back mangled or
   * with markup the client would then have to sanitise again. Plain text in,
   * plain text out, and no path by which translation can introduce HTML.
   *
   * No `source`: letting the provider detect it is what makes the feature work
   * on a mixed AZ/RU/EN campus feed, where the post carries no language field.
   */
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ q: text, target, format: 'text' }),
      // The route is already the slowest thing on the card; a hung upstream
      // must not hold a serverless invocation open to its own ceiling.
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new TranslationUnavailableError(
      `Translation request failed: ${(error as Error)?.message ?? 'unknown'}`,
    );
  }

  if (!response.ok) {
    // The body carries the provider's reason (quota, disabled API, bad key).
    // Logged, never returned: it can name the project and the key.
    const detail = await response.text().catch(() => '');
    console.error('[translate] upstream %d: %s', response.status, detail.slice(0, 500));
    throw new TranslationUnavailableError(`Translation upstream returned ${response.status}`);
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
  } | null;

  const first = payload?.data?.translations?.[0];
  if (!first?.translatedText) {
    throw new TranslationUnavailableError('Translation upstream returned no text');
  }

  return {
    text: decodeEntities(first.translatedText),
    detectedSourceLang: first.detectedSourceLanguage ?? null,
  };
}

/**
 * Undoes the provider's HTML escaping.
 *
 * v2 escapes `'`, `"` and `&` in its output even under `format: 'text'`, which
 * is a documented quirk and not a decision this code can change. Left alone,
 * every translated post containing an apostrophe renders as `it&#39;s` - the
 * single most visible way this feature can look broken.
 *
 * Only the five XML entities plus numeric escapes are decoded, and the result
 * is rendered as a TEXT NODE by React, so decoding cannot reintroduce markup.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Last: decoding it earlier would let `&amp;lt;` become `<`.
    .replace(/&amp;/g, '&');
}
