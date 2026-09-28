import { USERNAME_PATTERN, isReservedUsername } from './username';

/**
 * A handle suggested from the name Google supplied, so a first quick login
 * lands on /onboarding with "aysel_mammadova" already in the box instead of
 * an empty field.
 *
 * Only a SUGGESTION. The field stays editable, and whatever is submitted goes
 * through the same nicknameSchema and `usernames` claim as a typed handle. The
 * availability check below makes the suggestion likely to succeed; it does
 * not reserve anything - two people finishing onboarding at once can be
 * offered the same name, and completeProfile()'s transaction decides.
 *
 * Pure apart from the injected lookup, so the rules are unit-testable.
 */

const MAX_LENGTH = 24;

/**
 * Letters mapped by hand. Azerbaijani first, because it is the product's
 * default locale; "ə" and dotless "ı" have no Unicode decomposition, so the
 * NFKD pass below cannot reach them. The rest decompose anyway and are listed
 * so the table reads as the whole Azerbaijani rule.
 */
const LATIN: Record<string, string> = {
  ə: 'e', ı: 'i', ş: 's', ç: 'c', ğ: 'g', ö: 'o', ü: 'u',
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th',
};

/** Russian (plus the Azerbaijani and Ukrainian Cyrillic letters) to Latin. */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ә: 'e', ғ: 'g', ҝ: 'g', ҹ: 'c', һ: 'h', ө: 'o', ү: 'u', ј: 'y',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

/**
 * Lowercase ASCII-ish text from any Latin or Cyrillic name.
 *
 * NFC first, so a decomposed "й" (и + breve) is looked up as one letter.
 * `toLowerCase()`, not the locale variant - see username.ts. The capital
 * dotted "İ" lowercases to "i" plus a combining dot, which the mark strip
 * removes.
 */
export function transliterate(raw: string): string {
  return Array.from(raw.normalize('NFC').toLowerCase(), (ch) => LATIN[ch] ?? CYRILLIC[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

const trimTo = (value: string, max: number) => value.slice(0, max).replace(/_+$/, '');

/** One name part -> `[a-z0-9]` words joined by "_". */
const slug = (part: string | null | undefined) =>
  transliterate(part ?? '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** "Məmməd Həmidli" -> "memmed_hemidli". May be empty or shorter than 3. */
export function nicknameBase(firstName: string | null, lastName: string | null): string {
  return trimTo([slug(firstName), slug(lastName)].filter(Boolean).join('_'), MAX_LENGTH);
}

/**
 * The handles to try, best first: the bare name, then the name with 2..9
 * glued on, then three random suffixes for common names. The base is cut
 * short to make room for the suffix, so every candidate fits in 24.
 * Anything the chooser would refuse (too short, reserved) is dropped here.
 */
export function nicknameCandidates(
  firstName: string | null,
  lastName: string | null,
  random: () => number = Math.random,
): string[] {
  const base = nicknameBase(firstName, lastName);
  if (!base) return [];

  const suffixed = (n: number) => trimTo(base, MAX_LENGTH - String(n).length) + n;
  const list = [base];
  for (let n = 2; n <= 9; n++) list.push(suffixed(n));
  for (let i = 0; i < 3; i++) list.push(suffixed(100 + Math.floor(random() * 9_900)));

  return [...new Set(list)].filter((c) => USERNAME_PATTERN.test(c) && !isReservedUsername(c));
}

/**
 * The first candidate nobody holds, or null (no usable name, or all taken).
 *
 * `findTaken` gets every candidate in ONE call so a batched lookup costs the
 * same for one name as for twelve. Candidates are already lowercase, so they
 * are their own usernameKey().
 */
export async function suggestNickname(
  name: { firstName: string | null; lastName: string | null },
  findTaken: (keys: string[]) => Promise<Set<string>>,
  random?: () => number,
): Promise<string | null> {
  const candidates = nicknameCandidates(name.firstName, name.lastName, random);
  if (candidates.length === 0) return null;
  const taken = await findTaken(candidates);
  return candidates.find((candidate) => !taken.has(candidate)) ?? null;
}
