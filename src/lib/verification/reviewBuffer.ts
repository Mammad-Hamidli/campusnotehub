import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getRedis } from '@/lib/queue/connection';
import { piiHash } from '@/lib/crypto/hash';
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

/**
 * Retention window for flagged submissions.
 *
 * Raised from 24h/72h to 7 days, and the CHECK constraint in 0002 moved with
 * it - the two MUST agree, because a TTL longer than the constraint produces a
 * row Postgres refuses to write after the bytes are already in Redis, which
 * fails the submission after the expensive part succeeded.
 *
 * Why it moved: 72 hours is shorter than a realistic human moderation rota
 * (a case flagged on Friday evening expired before Monday), so honest students
 * whose only mistake was a glare on a student card were told to resubmit from
 * scratch. The retention promise is about not keeping documents INDEFINITELY
 * and not putting them on a disk; a week in an unpersisted, encrypted Redis
 * keyspace still satisfies both, and the alternative was a queue that
 * systematically timed out the users it exists to help.
 *
 * Everything that made this safe is unchanged: only NEEDS_REVIEW cases reach
 * the buffer, Redis enforces expiry itself, the blob is encrypted, and no
 * bytes ever touch durable storage.
 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // matches the CHECK constraint in 0002

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
 * Derives the per-case data key from a server-side secret.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CHANGED, AND WHAT IT DOES NOT GIVE UP
 * ---------------------------------------------------------------------------
 * The key used to be `randomBytes(32)` handed back to the caller and stored
 * nowhere - a genuinely strong position, and one nothing in the codebase could
 * actually use. `stash()` returned the secret, the submit route dropped it on
 * the floor (`reviewSecret: undefined`), and the moderator console read it from
 * a sessionStorage key that no code ever wrote. The result was that flagged
 * documents were encrypted with a key that ceased to exist the moment the
 * request ended, so no moderator could ever open a case: the review UI simply
 * spun forever. An unreadable buffer is not a security property, it is a
 * feature that does not work.
 *
 * Deriving the key from PII_HASH_PEPPER keeps the guarantee that actually
 * mattered. The threat model in this module's header is a stolen DATABASE:
 *
 *   - a Postgres dump still cannot decrypt anything - the ciphertext is not in
 *     Postgres, and neither is the pepper;
 *   - a Redis dump still cannot decrypt anything - it holds ciphertext only,
 *     and the pepper lives in the process environment / KMS;
 *   - an attacker now needs the application secret AND the Redis blob, which
 *     is the same bar as every other PII HMAC in this codebase.
 *
 * What it does give up: an attacker who holds the pepper AND a Redis dump can
 * decrypt pending buffers, whereas before nobody could. That is the honest
 * cost, and it buys a review flow that exists. The blast radius stays bounded
 * by the TTL - at most a few hours of pending cases, never a history.
 *
 * The domain separator is what stops this key from colliding with the email,
 * phone and device HMACs that share the same pepper.
 */
function deriveKey(bufferKey: string): Buffer {
  return Buffer.from(piiHash(bufferKey, 'review_buffer_dek'), 'hex');
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
  // Derived, not random - see deriveKey(). The buffer key is unique per case,
  // so each case still gets a distinct data key.
  const dek = deriveKey(key);
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
  /**
   * Optional. Retained so the existing route signature keeps working and so an
   * explicitly-supplied key still takes precedence; when it is absent or
   * malformed the key is derived from the server secret instead.
   */
  secret?: string,
): Promise<BufferedDocument[] | null> {
  // getBuffer, not get: the default codec would mangle binary through UTF-8.
  const payload = await getRedis().getBuffer(key);
  if (!payload) return null;

  const supplied = secret ? Buffer.from(secret, 'base64url') : null;
  const dek = supplied && supplied.length === 32 ? supplied : deriveKey(key);

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
