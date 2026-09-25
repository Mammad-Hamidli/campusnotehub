/**
 * Usernames: the public `@nickname` handle, now also accepted as a login
 * identifier alongside the email.
 *
 * ---------------------------------------------------------------------------
 * ONE NORMALISATION, USED EVERYWHERE
 * ---------------------------------------------------------------------------
 * The registration validator, the `usernames/{key}` uniqueness claim, the login
 * lookup and the backfill script must all agree on what "the same username"
 * means. If registration lowercased one way and login another, an account
 * could be registered under a key that login can never find - or worse, two
 * accounts could hold keys that login resolves to the same string. So the rule
 * lives here, once, and every caller imports it.
 *
 * The pattern is ASCII-only ([a-zA-Z0-9_]), which removes the whole class of
 * Unicode look-alike impersonation (Cyrillic "а" vs Latin "a") without needing
 * a confusables table.
 *
 * `toLowerCase()` and NOT `toLocaleLowerCase()`: this product's default locale
 * is Azerbaijani, where the locale-aware lowercase of "I" is dotless "ı". A
 * server that happened to run with an az locale would then map "ILKIN" and
 * "ilkin" to different keys. The plain method is locale-independent by spec,
 * and on an ASCII-only input it is exactly the mapping wanted.
 */

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;

/**
 * The canonical claim key for a username, or null when the input cannot be a
 * username at all. One leading "@" is accepted, because people type handles
 * the way the product displays them.
 */
export function usernameKey(raw: string): string | null {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return USERNAME_PATTERN.test(bare) ? bare.toLowerCase() : null;
}

/**
 * Handles nobody may CHOOSE - at registration, at onboarding, or by renaming
 * in Settings. They would let someone pass as the platform or its staff, or
 * collide with a route. Accounts provisioned by operators (bootstrap-admin)
 * do not go through the chooser and are unaffected.
 */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'administration', 'sysadmin', 'superuser', 'moderator', 'mod',
  'campusnotehub', 'support', 'help', 'staff', 'official', 'system', 'root', 'security',
  'team', 'owner', 'webmaster', 'postmaster', 'hostmaster', 'abuse', 'noreply', 'no_reply',
  'api', 'null', 'undefined', 'me', 'you', 'settings', 'login', 'logout', 'register',
  'dashboard', 'onboarding', 'mentors', 'profile',
]);

/**
 * Staff words refused as any `_`-separated PART of a handle, with digits
 * around it ignored: "admin_2", "mod99", "official_ada", "support_team".
 */
const STAFF_WORDS = new Set([
  'admin', 'administrator', 'sysadmin', 'superuser', 'moderator', 'mod', 'staff', 'official',
  'support', 'campusnotehub', 'root',
]);

/**
 * Words refused at the START or END of a handle even when glued to other
 * letters ("adminbob", "theadmin", "administrator2"). Not "anywhere" - that
 * would refuse "badminton".
 */
const STAFF_AFFIXES = ['admin', 'moderator', 'campusnotehub', 'superuser'];

/** The digit look-alikes people use to dodge a word list: "adm1n", "m0derator". */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };
const deLeet = (s: string) => s.replace(/[013457]/g, (d) => LEET[d]);
const trimDigits = (s: string) => s.replace(/^\d+|\d+$/g, '');

/**
 * The temporary handles quick-login accounts start with ("user34232" - see
 * temporaryHandle()). Refused as a CHOSEN nickname so a real person can never
 * look like an unfinished account, and so the random space stays free.
 */
export const TEMPORARY_HANDLE = /^user\d{5}$/i;

/**
 * True when `raw` may not be chosen as a handle. Shared by the server
 * validators and the client forms, so both refuse exactly the same names.
 */
export function isReservedUsername(raw: string): boolean {
  const key = raw.trim().replace(/^@/, '').toLowerCase();
  if (RESERVED_USERNAMES.has(key) || TEMPORARY_HANDLE.test(key)) return true;

  for (const token of key.split('_').filter(Boolean)) {
    if (STAFF_WORDS.has(trimDigits(token)) || STAFF_WORDS.has(trimDigits(deLeet(token)))) return true;
  }

  const compact = trimDigits(deLeet(key.replace(/_/g, '')));
  return STAFF_AFFIXES.some((word) => compact.startsWith(word) || compact.endsWith(word));
}

export type LoginIdentifier =
  | { kind: 'email'; value: string }
  | { kind: 'username'; value: string };

/** Deliberately loose - the full check is zod's .email() in the validator. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Classifies what someone typed into the single "email or username" box.
 *
 * The two forms cannot overlap: a username can never contain "@" (see the
 * pattern), and an email always has one after at least one character. A
 * leading "@" therefore means a handle ("@aysel"), and anything else holding
 * an "@" is treated as an email. That is what makes the classification total
 * and unambiguous - there is no input that could plausibly be read both ways
 * and so authenticate against two different accounts.
 */
export function parseLoginIdentifier(raw: string): LoginIdentifier | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;

  if (trimmed.indexOf('@') > 0) {
    const email = trimmed.toLowerCase();
    return EMAIL_SHAPE.test(email) ? { kind: 'email', value: email } : null;
  }

  const key = usernameKey(trimmed);
  return key ? { kind: 'username', value: key } : null;
}

/**
 * The temporary handle a quick-login account starts with, e.g. "user34232".
 *
 * Random rather than sequential so it reveals nothing about how many accounts
 * exist. Collisions are possible (90 000 values) and are handled by the
 * caller retrying - the `usernames` claim is what actually guarantees
 * uniqueness, this only proposes a candidate.
 */
export function temporaryHandle(): string {
  const digits = 10_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90_000);
  return `user${digits}`;
}

/**
 * An address for an account whose provider supplied none. `.invalid` is
 * reserved by RFC 2606, so nothing is ever delivered to it; the owner is asked
 * for a real address when completing their profile.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = 'pending.invalid';
export const isPlaceholderEmail = (email: string) => email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
