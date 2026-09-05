import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getRedis } from '@/lib/queue/connection';
import { wipe } from './fileValidation';

/**
 * The ephemeral review buffer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL - read before "simplifying" it away
 * ---------------------------------------------------------------------------
 * Two requirements in the spec pull in opposite directions:
 *
 *   (a) delete identity documents immediately after the AI returns a verdict;
 *   (b) route ambiguous cases to a human moderator who approves or bans.
 *
 * A moderator cannot review an image that was deleted. Something has to hold
 * the bytes between the AI verdict and the human decision, so the honest
 * question is not "retain or not" but "retain how little, for how long, where".
 *
 * The answer implemented here:
 *
 *   - ONLY ambiguous cases. Auto-approved and auto-rejected submissions never
 *     reach this module; their buffers are wiped before the HTTP response is
 *     written.
 *   - ONLY in Redis, configured with `maxmemory-policy noeviction` and
 *     appendonly/RDB persistence DISABLED, so the blob never reaches a disk.
 *     Deployment note in docs/SECURITY.md; a Redis with RDB on would silently
 *     write ID scans to a snapshot file and break the whole promise.
 *   - ONLY encrypted, with a per-case key that is returned to the caller and
 *     stored nowhere. Not in Postgres, not in Redis. It lives in the moderator
 *     review link. Losing the link means the blob is unrecoverable, which is
 *     the correct failure direction.
 *   - ONLY briefly. Redis enforces the TTL itself, so expiry does not depend
 *     on our cron running.
 *
 * Net effect: a database dump contains nothing, a disk image contains nothing,
 * and an unreviewed case erases itself.
 */

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 72 * 60 * 60; // matches the CHECK constraint in 0002

export type BufferedDocument = {
  kind: string;
  mime: string;
  bytes: Buffer;
};

export type ReviewBufferHandle = {
  /** Redis key. Safe to store in Postgres - useless without the secret. */
  key: string;
  /** Base64url. Returned once, persisted nowhere, carried in the review link. */
  secret: string;
  expiresAt: Date;
};

function ttlSeconds(): number {
  const configured = Number(process.env.REVIEW_BUFFER_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  return Math.min(Math.max(configured, 300), MAX_TTL_SECONDS);
}

/**
 * Encrypts the document set and parks it in Redis under a TTL.
 *
 * The caller MUST wipe its own copies of `documents[].bytes` afterwards; this
 * function wipes the intermediate serialisation but cannot reach the caller's
 * buffers.
 */
export async function stash(documents: BufferedDocument[]): Promise<ReviewBufferHandle> {
  const key = `kyc:review:${randomUUID()}`;
  const dek = randomBytes(32);
  const iv = randomBytes(12);

  // Length-prefixed framing so the parts can be split without a JSON encode of
  // the bytes (base64 in JSON would inflate a 5 MB image to ~6.7 MB and make a
  // second plaintext copy on the heap).
  const frames: Buffer[] = [];
  for (const doc of documents) {
    const header = Buffer.from(JSON.stringify({ kind: doc.kind, mime: doc.mime }), 'utf8');
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(header.length, 0);
    lengths.writeUInt32BE(doc.bytes.length, 4);
    frames.push(lengths, header, doc.bytes);
  }
  const plaintext = Buffer.concat(frames);

  try {
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, body]);

    const ttl = ttlSeconds();
    // setex, not set+expire: an unexpiring blob is the exact failure this
    // module exists to prevent, and two commands can interleave with a crash.
    await getRedis().setex(key, ttl, payload);

    return {
      key,
      secret: dek.toString('base64url'),
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  } finally {
    wipe(plaintext);
    wipe(dek);
  }
}

/**
 * Streams the buffered documents back for a moderator.
 *
 * Returns null when the TTL has already elapsed, which is a normal outcome and
 * must be handled as "ask the user to resubmit", not as an error.
 */
export async function retrieve(
  key: string,
  secret: string,
): Promise<BufferedDocument[] | null> {
  // getBuffer, not get: the default codec would mangle binary through UTF-8.
  const payload = await getRedis().getBuffer(key);
  if (!payload) return null;

  const dek = Buffer.from(secret, 'base64url');
  if (dek.length !== 32) return null;

  try {
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const body = payload.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);

    try {
      const documents: BufferedDocument[] = [];
      let offset = 0;
      while (offset < plaintext.length) {
        const headerLength = plaintext.readUInt32BE(offset);
        const bodyLength = plaintext.readUInt32BE(offset + 4);
        offset += 8;

        const header = JSON.parse(plaintext.toString('utf8', offset, offset + headerLength));
        offset += headerLength;

        // Copy out before the plaintext buffer is wiped below.
        documents.push({
          kind: header.kind,
          mime: header.mime,
          bytes: Buffer.from(plaintext.subarray(offset, offset + bodyLength)),
        });
        offset += bodyLength;
      }
      return documents;
    } finally {
      wipe(plaintext);
    }
  } catch {
    // Wrong secret or tampered ciphertext. Indistinguishable on purpose.
    return null;
  } finally {
    wipe(dek);
  }
}

/**
 * Destroys the buffer the instant a moderator decides. Called before the
 * decision is even written to Postgres - if the DB write then fails, the
 * correct state is "documents gone, case reopened", never "documents linger".
 */
export async function destroy(key: string): Promise<void> {
  await getRedis().del(key);
}

/**
 * Belt and braces for the TTL.
 *
 * Redis expires the blob on its own, so this sweep exists to reconcile the
 * Postgres side: clear the dangling key reference and reopen the case so the
 * user is told to resubmit rather than waiting forever on a review that can no
 * longer happen. Run from the scheduler worker every 15 minutes.
 */
export async function reapExpired(db: {
  verificationCase: {
    findMany: (args: unknown) => Promise<{ id: string; userId: string }[]>;
    updateMany: (args: unknown) => Promise<unknown>;
  };
}): Promise<number> {
  const expired = await db.verificationCase.findMany({
    where: { reviewBufferKey: { not: null }, reviewExpiresAt: { lt: new Date() } },
    select: { id: true, userId: true },
    take: 500,
  });
  if (expired.length === 0) return 0;

  await db.verificationCase.updateMany({
    where: { id: { in: expired.map((c) => c.id) } },
    data: {
      reviewBufferKey: null,
      reviewExpiresAt: null,
      status: 'REJECTED',
      publicMessageKey: 'verification.banner.resubmitRequired',
      failureCodes: ['REVIEW_WINDOW_EXPIRED'],
      decidedAt: new Date(),
    },
  });

  return expired.length;
}
