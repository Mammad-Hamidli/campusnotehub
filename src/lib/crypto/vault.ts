import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Field-level encryption for short secrets at rest (booking meeting URLs).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NO LONGER AWS KMS
 * ---------------------------------------------------------------------------
 * This module used to wrap every value with KMS envelope encryption, keyed by
 * KMS_KEY_ID_DOCS. That key was never provisioned in any environment, so
 * seal() threw on EVERY booking and no mentor session could ever be booked.
 * It was also the last AWS dependency in a Firebase-only application.
 *
 * It is now AES-256-GCM with a key derived (HKDF-SHA256) from a server-only
 * secret: VAULT_KEY if set, otherwise PII_HASH_PEPPER, which every deployment
 * already has to hold. Properties kept from the KMS version:
 *
 *  - a fresh random IV per value, and GCM authentication, so a tampered or
 *    truncated ciphertext fails to open instead of decrypting to garbage;
 *  - the caller's `context` is bound as additional authenticated data, so a
 *    value sealed for booking A cannot be opened while claiming booking B
 *    (the same guarantee KMS EncryptionContext gave).
 *
 * What is given up is CloudTrail-attributable decrypts and crypto-shredding by
 * deleting a KMS key. For meeting URLs - which are useless without the
 * per-session join JWT anyway - that trade is proportionate.
 *
 * Format: `v1.<base64(iv || tag || ciphertext)>`.
 */
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.VAULT_KEY || process.env.PII_HASH_PEPPER;
  if (!secret) {
    throw new Error('Vault is not configured: set VAULT_KEY (or PII_HASH_PEPPER).');
  }
  cachedKey = Buffer.from(hkdfSync('sha256', secret, 'campushub-vault', 'field-encryption:v1', 32));
  return cachedKey;
}

/** Canonical, order-independent encoding of the context, used as GCM AAD. */
function aad(context: Record<string, string>): Buffer {
  const entries = Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Buffer.from(JSON.stringify(entries), 'utf8');
}

export function seal(plaintext: Buffer, context: Record<string, string>): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  cipher.setAAD(aad(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, body]).toString('base64')}`;
}

export function open(packed: string, context: Record<string, string>): Buffer {
  const [version, payload] = packed.split('.', 2);
  if (version !== VERSION || !payload) throw new Error('Unsupported sealed value');

  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Convenience wrappers for short JSON fields. Async for call-site compatibility. */
export async function sealJson(value: unknown, context: Record<string, string>): Promise<string> {
  return seal(Buffer.from(JSON.stringify(value), 'utf8'), context);
}

export async function openJson<T>(packed: string, context: Record<string, string>): Promise<T> {
  return JSON.parse(open(packed, context).toString('utf8')) as T;
}
