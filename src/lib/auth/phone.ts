/**
 * Azerbaijani mobile numbers: ONE normaliser, shared by the form and the
 * server schema.
 *
 * This lives in its own module rather than next to either caller because the
 * two must agree exactly. The registration form normalises before it submits,
 * registerSchema normalises again before it validates, and hashPhone() hashes
 * the digits - three places that have to collapse '+994 50 123 45 67',
 * '050 123 45 67' and '994501234567' to the same value. A second copy of this
 * rule anywhere is a duplicate-detection bug waiting to happen: two spellings
 * of one number would hash differently and both would be accepted.
 */

/**
 * Mobile operator codes issued in Azerbaijan. Landline ranges (012 Baku, 018,
 * 020…) are deliberately absent: the number is for account recovery and payout
 * confirmation, both of which are SMS, and a landline silently fails at the
 * only moment it is needed.
 */
const MOBILE_PREFIXES = ['10', '40', '50', '51', '55', '60', '70', '77', '99'] as const;

const E164 = new RegExp(`^994(${MOBILE_PREFIXES.join('|')})\\d{7}$`);

/**
 * Returns the number in E.164 ('+994501234567'), or null if it is not a valid
 * Azerbaijani mobile number.
 *
 * Everything that is not a digit is dropped first, so spaces, dashes and
 * parentheses are all accepted from the user - formatting is presentation, and
 * refusing a number because it was pasted with spaces in it is the kind of
 * validation that only ever annoys the person typing.
 */
export function normalizeAzPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');

  // '00994…' -> '994…'
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Local trunk form '050 123 45 67' -> '994501234567'
  if (digits.length === 10 && digits.startsWith('0')) digits = `994${digits.slice(1)}`;
  // Bare subscriber form '501234567' -> '994501234567'
  if (digits.length === 9) digits = `994${digits}`;

  return E164.test(digits) ? `+${digits}` : null;
}
