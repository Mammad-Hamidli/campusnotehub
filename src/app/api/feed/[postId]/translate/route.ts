import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getViewer } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { findVisiblePost } from '@/lib/feed/visibility';
import { normalizeTargetLang } from '@/lib/i18n/translatable';
import {
  translateText,
  translationConfigured,
  TranslationUnavailableError,
} from '@/lib/translate/provider';
import {
  cacheTranslation,
  findCachedTranslation,
} from '@/lib/firebase/repositories/translations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/feed/:postId/translate  { lang }  ->  { lang, text, detectedSourceLang, cached }
 *
 * ---------------------------------------------------------------------------
 * WHY THE VISIBILITY CHECK IS THE FIRST THING THAT MATTERS
 * ---------------------------------------------------------------------------
 * This endpoint returns a post's BODY. Without findVisiblePost it is a second,
 * unguarded way to read one - anyone holding a post id could translate a
 * UNIVERSITY_ONLY or FOLLOWERS post into the language it was already written
 * in and read it verbatim. That is the exact failure src/lib/feed/visibility.ts
 * was extracted to prevent for comments and likes, and it applies here with
 * more force, because the response IS the content.
 *
 * Reading is not an interaction, so unlike the like endpoint this one does NOT
 * require a session and does not check `feed:react`: a signed-out visitor
 * looking at a PUBLIC post gets the same audience tokens the feed gives them,
 * and nothing more. `getViewer()` rather than `requireSession()` is what
 * expresses that.
 *
 * ---------------------------------------------------------------------------
 * WHY POST AND NOT GET
 * ---------------------------------------------------------------------------
 * It is billable and it writes (the cache), so it must not be prefetched,
 * link-previewed or retried by a CDN. A GET with `?lang=` would be all three.
 */

const schema = z.object({ lang: z.string().min(2).max(10) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  // Accepts `ch`, `zh-CN`, `de-AT` and folds them onto a supported target;
  // see the header of src/lib/i18n/translatable.ts for why `ch` is an alias.
  const lang = normalizeTargetLang(parsed.data.lang);
  if (!lang) {
    return NextResponse.json({ error: 'feed.translate.errors.unsupported' }, { status: 400 });
  }

  const viewer = await getViewer();

  /**
   * Rate limited BEFORE the provider call and before the post read, and keyed
   * per user (per address when signed out). Every miss is money: an unlimited
   * endpoint that bills per character is a way to spend the project's budget
   * from a loop. The limit is generous enough that reading a feed page in
   * another language never reaches it.
   */
  const rate = await rateLimit('feed:translate', {
    userId: viewer?.id,
    ip: clientIp(request.headers),
  });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const post = await findVisiblePost(postId, viewer);
  if (!post) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const source = String(post.body ?? '');
  if (!source.trim()) {
    return NextResponse.json({ error: 'feed.translate.errors.empty' }, { status: 422 });
  }

  // The cache is checked before the configuration test: a deployment that has
  // since lost its key still serves what it already translated.
  const cached = await findCachedTranslation(postId, lang, source);
  if (cached) {
    return NextResponse.json(
      { lang, text: cached.text, detectedSourceLang: cached.detectedSourceLang, cached: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!translationConfigured()) {
    return NextResponse.json({ error: 'feed.translate.errors.unavailable' }, { status: 503 });
  }

  let result;
  try {
    result = await translateText(source, lang);
  } catch (error) {
    if (error instanceof TranslationUnavailableError) {
      console.error('[translate] %s -> %s: %s', postId, lang, error.message);
      return NextResponse.json({ error: 'feed.translate.errors.unavailable' }, { status: 503 });
    }
    throw error;
  }

  /**
   * The cache write is NOT awaited into the response path's failure modes: the
   * translation is already paid for and already correct, and a Firestore hiccup
   * must not turn it into a 500. The only cost of a lost write is translating
   * the same post once more.
   */
  void cacheTranslation({
    postId,
    lang,
    body: source,
    text: result.text,
    detectedSourceLang: result.detectedSourceLang,
  }).catch((error) => console.error('[translate] cache write failed', error));

  return NextResponse.json(
    { lang, text: result.text, detectedSourceLang: result.detectedSourceLang, cached: false },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
