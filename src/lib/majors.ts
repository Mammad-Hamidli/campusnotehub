/**
 * The global majors list, from src/data/majors.json.
 *
 * One list for every student regardless of university: a major means the same
 * thing at BDU, SDU or ADA, so the picker never depends on which university was
 * chosen. The JSON is a flat, pre-deduplicated array of labels in the official
 * Azerbaijani classifier spelling; programmes without an established Azerbaijani
 * name (several of ADA's) keep their official English name.
 *
 * Majors are persisted to `users.facultySlug` alongside the legacy catalogue in
 * faculties.ts. Their slug is DERIVED from the label, so the label spelling is
 * the contract: correcting one changes its slug and orphans existing users.
 * Two labels that transliterate to the same slug throw at module load, so a
 * near-duplicate fails the build instead of shadowing an existing major.
 */
import labels from '@/data/majors.json';

export type MajorOption = { slug: string; label: string };

const AZ_TRANSLIT: Record<string, string> = { ə: 'e', ı: 'i', ö: 'o', ü: 'u', ç: 'c', ş: 's', ğ: 'g' };

/** "Neft-qaz mühəndisliyi" -> "neft-qaz-muhendisliyi". */
export function majorSlug(label: string): string {
  return label
    .toLocaleLowerCase('az')
    .replace(/[əıöüçşğ]/g, (c) => AZ_TRANSLIT[c])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const LABEL_BY_SLUG: ReadonlyMap<string, string> = (labels as string[]).reduce((map, label) => {
  const slug = majorSlug(label);
  if (map.has(slug)) throw new Error(`majors.json: "${label}" duplicates "${map.get(slug)}"`);
  return map.set(slug, label);
}, new Map<string, string>());

/** Every major, in the JSON's (alphabetical) order. */
export const MAJORS: readonly MajorOption[] = [...LABEL_BY_SLUG].map(([slug, label]) => ({ slug, label }));

export const MAJOR_SLUGS: ReadonlySet<string> = new Set(LABEL_BY_SLUG.keys());

export function majorLabel(slug: string): string | undefined {
  return LABEL_BY_SLUG.get(slug);
}
