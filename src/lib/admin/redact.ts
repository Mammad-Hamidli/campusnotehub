/**
 * Redaction helpers for admin listings.
 *
 * These exist so the decision "how much of this is shown while browsing" is
 * made once, in one file, rather than re-derived at each call site with a
 * slightly different slice index.
 */

/**
 * Masks a phone number to its country/operator prefix and last two digits:
 *   +994501234567 -> +99450*****67
 *
 * Enough to recognise a number you already know, tell two accounts apart, and
 * see which operator issued it - which is what a moderator triaging a list
 * actually needs. Not enough to harvest the number, which is the point: SIM
 * registration in Azerbaijan is identity-linked, so a full number in a bulk
 * listing is a stronger identifier than the email beside it.
 *
 * The unmasked value is returned by the single-user detail endpoint, where the
 * read is deliberate and audited.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length <= 6) return '*'.repeat(phone.length);
  const head = phone.slice(0, 6);
  const tail = phone.slice(-2);
  return `${head}${'*'.repeat(Math.max(1, phone.length - 8))}${tail}`;
}

/**
 * Shortens a device fingerprint for display.
 *
 * The full value is a ban anchor: pasting one into the blocklist blocks a
 * device, so it is a capability rather than an identifier. Twelve characters
 * are plenty to correlate two rows on screen.
 */
export function shortFingerprint(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null;
  return `${fingerprint.slice(0, 12)}…`;
}
