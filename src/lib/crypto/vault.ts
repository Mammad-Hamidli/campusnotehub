import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const kms = new KMSClient({ region: process.env.S3_REGION });

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export type Envelope = {
  /** Base64 ciphertext: iv || authTag || payload */
  ciphertext: string;
  /** Base64 KMS-wrapped data key. Useless without KMS decrypt permission. */
  wrappedDek: string;
};

/**
 * Envelope encryption.
 *
 * Every document and every sensitive field gets its own random 256-bit data
 * key. The plaintext data key never touches disk - only the KMS-wrapped
 * version does. Consequences that matter operationally:
 *
 *  - Deleting the KMS key cryptographically shreds every document at once,
 *    which is how we honour an erasure request against S3 versions and
 *    backups we cannot practically rewrite.
 *  - KMS decrypt calls are logged in CloudTrail, so every single access to a
 *    national ID image is attributable, with no extra code on our side.
 *  - A stolen database dump is inert.
 */
export async function seal(plaintext: Buffer, context: Record<string, string>): Promise<Envelope> {
  const { Plaintext, CiphertextBlob } = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: process.env.KMS_KEY_ID_DOCS,
      KeySpec: 'AES_256',
      // Bound to the subject: a DEK wrapped for user A cannot be unwrapped
      // while claiming to be user B, even by someone with KMS access.
      EncryptionContext: context,
    }),
  );
  if (!Plaintext || !CiphertextBlob) throw new Error('KMS did not return a data key');

  const dek = Buffer.from(Plaintext);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, dek, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, tag, body]).toString('base64'),
      wrappedDek: Buffer.from(CiphertextBlob).toString('base64'),
    };
  } finally {
    dek.fill(0); // do not leave key material for the GC to hand out later
  }
}

export async function open(envelope: Envelope, context: Record<string, string>): Promise<Buffer> {
  const { Plaintext } = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(envelope.wrappedDek, 'base64'),
      EncryptionContext: context,
    }),
  );
  if (!Plaintext) throw new Error('KMS refused to unwrap the data key');

  const dek = Buffer.from(Plaintext);
  try {
    const raw = Buffer.from(envelope.ciphertext, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
    const body = raw.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv(ALGO, dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}

/** Convenience wrappers for short JSON fields (OCR payloads, meeting URLs). */
export async function sealJson(value: unknown, context: Record<string, string>) {
  const env = await seal(Buffer.from(JSON.stringify(value), 'utf8'), context);
  return `${env.wrappedDek}.${env.ciphertext}`;
}

export async function openJson<T>(packed: string, context: Record<string, string>): Promise<T> {
  const [wrappedDek, ciphertext] = packed.split('.', 2);
  const buf = await open({ wrappedDek, ciphertext }, context);
  return JSON.parse(buf.toString('utf8')) as T;
}
