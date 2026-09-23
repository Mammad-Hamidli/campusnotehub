import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import qrcode from 'qrcode-generator';

/**
 * TOTP (RFC 6238) and recovery codes. Pure functions: no Firestore, no vault.
 * Storage, replay protection and lockout live in repositories/mfa.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY SHA-1 / 6 DIGITS / 30 SECONDS
 * ---------------------------------------------------------------------------
 * Those are the only parameters every authenticator app honours. Google
 * Authenticator silently ignores `algorithm=SHA256` in the otpauth URI and
 * keeps generating SHA-1 codes, so choosing a "stronger" hash produces an
 * enrollment that never verifies. SHA-1's collision weakness is irrelevant to
 * HMAC, which is what TOTP uses.
 *
 * The secret is 160 bits, the size RFC 4226 recommends for HMAC-SHA1.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * Steps accepted either side of "now". One step (30 s) absorbs a phone clock
 * that has drifted a little and the time it takes to type a code, while
 * keeping the number of codes valid at any moment at three - a 3-in-a-million
 * guess per attempt, which the rate limit and lockout keep far from useful.
 */
export const TOTP_DRIFT_STEPS = 1;
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, which is what otpauth URIs carry. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Inverse of base32Encode, tolerant of the spaces and lowercase a person types.
 * Used by tooling that holds a setup key (e2e fixtures), never by a request
 * path - the app only ever stores the raw secret, sealed.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4226 HOTP, dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Returns the time-step the code belongs to, or null.
 *
 * The STEP is returned rather than a boolean because a boolean cannot stop a
 * replay: the caller has to record the step and refuse any code whose step is
 * not strictly newer (see verifySecondFactor). Without that, a code shoulder-
 * surfed or phished in real time stays valid for up to 90 seconds.
 *
 * Every candidate in the window is compared, in constant time, even after a
 * match - so response time does not reveal which window slot matched.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let delta = -TOTP_DRIFT_STEPS; delta <= TOTP_DRIFT_STEPS; delta++) {
    const step = now + delta;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given) && matched === null) matched = step;
  }
  return matched;
}

/** Accepts "123 456" and "123-456" as typed or pasted from an app. */
export function normalizeTotpInput(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

/**
 * The provisioning URI an authenticator app reads from the QR code.
 *
 * The label shows the public handle, never the email: the entry sits in an
 * app that is often backed up to a cloud account and shown on a lock screen,
 * and it needs to identify the account to its owner, not to anyone else.
 */
export function otpauthUri(secret: Buffer, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * The QR code as an SVG data URL, rendered on the server.
 *
 * Server-side on purpose: the URI contains the secret, and generating the
 * image in the browser would mean shipping the secret to a client-side library
 * and a canvas anyway. This way the only copy the browser gets is the one it
 * must display. Error correction M is what authenticator apps are tested with.
 */
export function qrSvgDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** The secret as a person types it into an app: base32 in groups of four. */
export function formatSecretForManualEntry(secret: Buffer): string {
  return base32Encode(secret).replace(/(.{4})(?=.)/g, '$1 ');
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * No 0/O, 1/I/L: a recovery code is read off paper, often under stress, and
 * look-alike characters are how a correct code becomes a failed attempt.
 * 31 symbols x 16 characters is ~79 bits, which is what lets the codes be
 * stored as a fast keyed hash rather than Argon2: even with the database AND
 * the pepper leaked, 2^79 guesses per code is out of reach.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 16;
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCode(): string {
  let raw = '';
  // randomInt is rejection-sampled, so every symbol is equally likely.
  for (let i = 0; i < RECOVERY_LENGTH; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, newRecoveryCode);
}

/**
 * Canonical form for hashing: case, spaces and hyphens are presentation.
 * Returns null for anything that cannot be a recovery code, so a malformed
 * value is rejected before it costs a hash or a database read.
 */
export function normalizeRecoveryCode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== RECOVERY_LENGTH) return null;
  for (const ch of compact) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return compact;
}
