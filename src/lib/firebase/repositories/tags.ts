import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { forFirestore } from '../convert';

/**
 * Hashtags.
 *
 * ---------------------------------------------------------------------------
 * THE SLUG IS THE DOCUMENT ID
 * ---------------------------------------------------------------------------
 * `Tag.slug` was `@unique` in SQL. Firestore has no unique index, so the
 * constraint is expressed structurally instead: keying the document by the
 * slug makes a duplicate tag unrepresentable rather than merely forbidden, and
 * turns the upsert below into a keyed write with no lookup.
 *
 * This is the same move used for wallets (keyed by owner) and post likes
 * (keyed by liker). Where SQL had a unique constraint, the Firestore
 * translation puts that value in the document id wherever it can.
 */

const tags = () => adminDb().collection(COLLECTIONS.tags);

/**
 * Creates or bumps each tag, and returns the ones a post may carry.
 *
 * BLOCKED TAGS ARE DROPPED, not rejected: the SQL version skipped creating the
 * join row for a blocked tag and let the post through, so a moderated hashtag
 * silently stops propagating rather than failing someone's post. Preserved
 * deliberately - changing it would turn a moderation action into a visible
 * error for an author who may have typed the tag innocently.
 *
 * The usage counter uses FieldValue.increment(), which is atomic server-side,
 * so simultaneous posts using the same tag both count.
 */
export async function upsertTags(
  raw: string[],
): Promise<{ slug: string; label: string }[]> {
  if (raw.length === 0) return [];

  // Locale-aware lowercasing: Azerbaijani 'I' does not fold to 'i', and using
  // the default would make #İMKB and #imkb different tags.
  const wanted = new Map<string, string>();
  for (const value of raw) {
    const slug = value.toLocaleLowerCase('az');
    if (!wanted.has(slug)) wanted.set(slug, value);
  }

  const slugs = [...wanted.keys()];
  const refs = slugs.map((slug) => tags().doc(slug));
  const existing = await adminDb().getAll(...refs);

  const batch = adminDb().batch();
  const allowed: { slug: string; label: string }[] = [];

  existing.forEach((snap, i) => {
    const slug = slugs[i];
    const label = wanted.get(slug) ?? slug;

    if (!snap.exists) {
      batch.set(
        refs[i],
        forFirestore({
          slug,
          label,
          usageCount: 1,
          isBlocked: false,
          createdAt: new Date(),
        }),
      );
      allowed.push({ slug, label });
      return;
    }

    const data = snap.data() ?? {};
    batch.update(refs[i], { usageCount: FieldValue.increment(1) });
    // A blocked tag still counts - the counter is what tells a moderator how
    // often it is being attempted - but it does not reach the post.
    if (data.isBlocked !== true) {
      allowed.push({ slug, label: (data.label as string) || label });
    }
  });

  await batch.commit();
  return allowed;
}

