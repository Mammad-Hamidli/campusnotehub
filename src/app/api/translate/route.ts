import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getViewer } from '@/lib/auth/session';
import { normalizeTargetLang } from '@/lib/i18n/translatable';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { TranslationError, type TranslationErrorCode } from '@/lib/translate/errors';
import { libreTranslateConfig, translatePost } from '@/lib/translate/libretranslate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A post body's own cap (POST /api/feed): nothing longer is on screen to translate. */
const MAX_TEXT = 2000;

const Body = z.object({
  text: z.string().max(MAX_TEXT),
  target: z.string().max(16),
});

const STATUS: Record<TranslationErrorCode, number> = {
  empty: 400,
  failed: 502,
  quota: 429,
  sameLanguage: 422,
  unavailable: 503,
};

const NO_STORE = { 'Cache-Control': 'no-store' };

function failure(code: TranslationErrorCode, status = STATUS[code], headers: Record<string, string> = {}) {
  return NextResponse.json({ error: `feed.translate.errors.${code}` }, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * POST /api/translate { text, target } -> { translation } - "Translate" on a
 * feed post (src/components/dashboard/PostTranslation.tsx).
 *
 * A proxy to LibreTranslate (src/lib/translate/libretranslate.ts), so the
 * instance URL and API key stay on the server. Open to signed-out readers,
 * because the feed and public profiles are readable signed out and translating
 * is reading; limited on the `translate` bucket, per user when signed in and
 * per hashed address otherwise. Errors are feed.translate.errors.* keys.
 */
export async function POST(request: NextRequest) {
  const config = libreTranslateConfig();
  // Not configured: the card says "unavailable" and no bucket is charged.
  if (!config) return failure('unavailable');

  // A malformed request is the caller's fault (400), though the card can only say "failed".
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failure('failed', 400);
  const target = normalizeTargetLang(parsed.data.target);
  if (!target) return failure('failed', 400);
  if (!parsed.data.text.trim()) return failure('empty');

  const viewer = await getViewer();
  const rate = await rateLimit('translate', { userId: viewer?.id, ip: clientIp(request.headers) });
  if (!rate.ok) return failure('quota', 429, { 'Retry-After': String(rate.retryAfterSeconds) });

  try {
    const translation = await translatePost(parsed.data.text, target, config);
    return NextResponse.json({ translation }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof TranslationError) return failure(error.code);
    throw error;
  }
}
