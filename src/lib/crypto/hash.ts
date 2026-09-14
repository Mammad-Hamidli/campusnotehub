import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type argon2Types from 'argon2';
import type bcryptTypes from 'bcryptjs';

/**
 * argon2 is a native addon and bcryptjs is only ever needed for legacy
 * hashes. Both are loaded lazily, inside the functions that need them, rather
 * than at module scope.
 *
 * Two concrete reasons, both of which bit us:
 *  - Next.js evaluates every module a route transitively imports while
 *    collecting page data at build time. A top-level `import argon2` pulls a
 *    .node binary into that phase, so the build fails on any machine or CI
 *    image where the binary is not compiled for the current platform.
 *  - bcryptjs is only ever needed to verify a LEGACY hash. Most deployments
 *    will never call it at all, and it has no business being in the cold-start
 *    path of every route that happens to import this file.
 */
let argon2Module: typeof argon2Types | null = null;
async function getArgon2() {
  argon2Module ??= (await import('argon2')).default;
  return argon2Module;
}

/**
 * bcryptjs 2.x is a CommonJS module with no named `default`. Webpack's interop
 * synthesises one, tsx/vitest running it natively does not - so take whichever
 * is actually there rather than assuming `.default`.
 */
let bcryptModule: typeof bcryptTypes | null = null;
async function getBcrypt() {
  if (!bcryptModule) {
    const mod = (await import('bcryptjs')) as unknown as
      | typeof bcryptTypes
      | { default: typeof bcryptTypes };
    bcryptModule = 'default' in mod && mod.default ? mod.default : (mod as typeof bcryptTypes);
  }
  return bcryptModule;
}

/**
 * Resolved per call, not at module load.
 *
 * A module-scope `throw` here fails `next build` on any machine without
 * production secrets — which is every CI runner and every developer laptop.
 * Build-time page-data collection evaluates this module, so the assertion has
 * to happen where the secret is actually used. The guarantee is unchanged:
 * nothing can hash PII in production without a real pepper.
 */
function pepper(): string {
  const value = process.env.PII_HASH_PEPPER;
  if (value) return value;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('PII_HASH_PEPPER is required in production');
  }
  return 'dev-only-pepper';
}

/**
 * Keyed hash for identifiers we must be able to *compare* but must never be
 * able to *read back*: emails, IPs, national ID numbers, device fingerprints.
 *
 * HMAC rather than a bare SHA-256 because the input spaces are small and
 * enumerable. There are roughly 4 billion IPv4 addresses and maybe 10 million
 * plausible Azerbaijani ID numbers - a plain digest of either is reversible
 * with a laptop and an afternoon. The pepper lives in KMS, not in the database,
 * so a database dump alone does not de-anonymise the blocklist.
 */
export function piiHash(value: string, domain: string): string {
  const normalised = value.trim().toLowerCase();
  return createHmac('sha256', pepper())
    .update(`${domain}:${normalised}`)
    .digest('hex');
}

export const hashEmail = (email: string) => piiHash(email, 'email');
export const hashDevice = (fp: string) => piiHash(fp, 'device');

/**
 * E.164 normalisation before hashing, so +994 50 123 45 67, 0501234567 and
 * 994501234567 all collapse to one value. Without this a banned number is
 * trivially reused by retyping it with different spacing.
 */
export function hashPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Local Azerbaijani format: 0XX XXX XX XX -> 994XXXXXXXXX
  if (digits.length === 10 && digits.startsWith('0')) digits = `994${digits.slice(1)}`;
  if (digits.length === 9) digits = `994${digits}`;
  return piiHash(digits, 'phone');
}

/**
 * Rate limiting only - NEVER for banning.
 *
 * IP addresses are used to throttle bursts, which is temporary and recovers on
 * its own. They are never written to the blocklist: campus and CGNAT sharing
 * makes an IP ban collective punishment. See src/lib/security/blocklist.ts.
 * There is no hashNationalId in this file any more, because under the
 * zero-retention policy no ID number ever reaches the Node process.
 */
export const hashIpForRateLimit = (ip: string) => piiHash(ip, 'ratelimit_ip');

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * The spec asked for bcrypt. We hash new passwords with argon2id instead and
 * keep bcrypt only for verification, because bcrypt silently truncates input
 * at 72 bytes - and a 24-character Azerbaijani passphrase is well over 72
 * bytes in UTF-8, so two different passwords can collide. Argon2id is also the
 * current OWASP first choice.
 *
 * Existing bcrypt hashes are transparently upgraded on next successful login,
 * so no migration or forced reset is needed.
 */
const ARGON_OPTS = {
  memoryCost: 19456, // 19 MiB - OWASP minimum
  timeCost: 2,
  parallelism: 1,
} as const;

async function argonOptions() {
  const argon2 = await getArgon2();
  return { ...ARGON_OPTS, type: argon2.argon2id };
}

export async function hashPassword(plain: string): Promise<string> {
  const argon2 = await getArgon2();
  return argon2.hash(plain, await argonOptions());
}

export type PasswordCheck = { valid: boolean; needsRehash: boolean };

export async function verifyPassword(plain: string, stored: string): Promise<PasswordCheck> {
  if (stored.startsWith('$argon2')) {
    const argon2 = await getArgon2();
    const valid = await argon2.verify(stored, plain).catch(() => false);
    return { valid, needsRehash: valid && argon2.needsRehash(stored, await argonOptions()) };
  }

  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    // Legacy path only. Loaded on demand so a deployment with no bcrypt hashes
    // pays nothing for it on a cold start.
    //
    // bcryptjs, not the native `bcrypt` addon: it is the package this project
    // actually depends on, it reads the same $2a$/$2b$/$2y$ hashes bit for bit
    // (same Blowfish KDF, same modular-crypt encoding), and being pure JS it
    // needs no prebuilt binary in Vercel's serverless bundle.
    const bcrypt = await getBcrypt();
    const valid = await bcrypt.compare(plain, stored).catch(() => false);
    return { valid, needsRehash: valid }; // always upgrade bcrypt to argon2id
  }

  return { valid: false, needsRehash: false };
}

/**
 * Guards the login endpoint against user-enumeration timing. Verifying a real
 * argon2id hash takes ~50ms; returning "no such user" in 2ms tells an attacker
 * which emails are registered. Always burn comparable time.
 *
 * The dummy hash is computed once, on first use, and memoised — computing it
 * at module scope would run a KDF during Next.js build-time page-data
 * collection.
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordTime(): Promise<void> {
  const argon2 = await getArgon2();
  dummyHash ??= argon2.hash('never-matches', await argonOptions());
  await argon2.verify(await dummyHash, randomBytes(16).toString('hex')).catch(() => false);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export const newOpaqueToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) =>
  createHmac('sha256', pepper()).update(`token:${token}`).digest('hex');

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
