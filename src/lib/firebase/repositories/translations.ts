import { createHash } from 'node:crypto';
import { adminDb } from '../admin.core';
import { forFirestore } from '../convert';
import type { TargetLang } from '@/lib/i18n/translatable';

/**
 * The translation cache.
 *
 * ---------------------------------------------------------------------------
 * WHY A CACHE IS NOT OPTIONAL HERE
 * ---------------------------------------------------------------------------
 * Translation is billed PER CHARACTER. A popular post read by four hundred
 * students is one translation and four hundred reads, or four hundred
 * translations, depending only on whether this collection exists. It is also
 * the difference between a 400ms upstream round trip and a single-document
 * read on the second viewer.
 *
 * And it is the only thing that makes the result STABLE: two students looking
 * at the same post in German must see the same German, or the comment thread
 * underneath stops making sense.
 *
 * ---------------------------------------------------------------------------
 * THE KEY INCLUDES A HASH OF THE SOURCE
 * ---------------------------------------------------------------------------
 * `{postId}__{lang}__{sha256(body).slice(0,16)}`. Posts are not editable
 * today - the card offers delete and report, never edit - so the hash is
 * insurance rather than a live requirement. It costs nothing and it means that
 * the day an edit action is added, a stale translation is IMPOSSIBLE rather
 * than merely unlikely: a changed body simply misses the cache. Keying on
 * `{postId}__{lang}` alone would silently serve the old text forever.
 *
 * 16 hex characters is 64 bits, which is not a collision risk for a cache
 * scoped to one post and one language.
 *
 * ---------------------------------------------------------------------------
 * ENTRIES EXPIRE
 * ---------------------------------------------------------------------------
 * Every document carries `expiresAt` and the deployment declares a Firestore
 * TTL policy on it, exactly as rateLimits does:
 *
 *     gcloud firestore fields ttls update expiresAt \
 *       --collection-group=postTranslations --enable-ttl
 *
 * Without the policy nothing is wrong - a cached translation is still correct,
 * it is simply never collected. Note that deleting a post does NOT delete its
 * translations: they are a derived, non-authoritative copy of a body, and
 * recursiveDelete on the post never reaches a separate top-level collection.
 * The TTL is what bounds that, and it is why the cache is not nested under the
 * post (a subcollection would be deleted with it, but would also make the
 * collection-group read needed for prefetching a whole feed page awkward).
 */

const COLLECTION = 'postTranslations';
const TTL_DAYS = 90;

export type CachedTranslation = {
  text: string;
  detectedSourceLang: string | null;
  lang: TargetLang;
};

export function sourceFingerprint(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

/** `/` is the one character a document id may not contain; none of the parts can produce one. */
function cacheKey(postId: string, lang: TargetLang, fingerprint: string): string {
  return `${postId}__${lang}__${fingerprint}`;
}

export async function findCachedTranslation(
  postId: string,
  lang: TargetLang,
  body: string,
): Promise<CachedTranslation | null> {
  const snap = await adminDb()
    .collection(COLLECTION)
    .doc(cacheKey(postId, lang, sourceFingerprint(body)))
    .get();

  if (!snap.exists) return null;
  const text = snap.get('text');
  if (typeof text !== 'string' || !text) return null;

  return {
    text,
    detectedSourceLang: (snap.get('detectedSourceLang') as string | null) ?? null,
    lang,
  };
}

/**
 * Stores a translation. Fire-and-forget at the call site: a failed cache write
 * must never turn a translation the user is already holding into an error.
 */
export async function cacheTranslation(params: {
  postId: string;
  lang: TargetLang;
  body: string;
  text: string;
  detectedSourceLang: string | null;
}): Promise<void> {
  const now = new Date();
  await adminDb()
    .collection(COLLECTION)
    .doc(cacheKey(params.postId, params.lang, sourceFingerprint(params.body)))
    .set(
      forFirestore({
        postId: params.postId,
        lang: params.lang,
        sourceFingerprint: sourceFingerprint(params.body),
        text: params.text,
        detectedSourceLang: params.detectedSourceLang,
        createdAt: now,
        expiresAt: new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60_000),
      }),
    );
}
