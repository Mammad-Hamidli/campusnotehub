import { randomUUID } from 'node:crypto';
import { cloudinaryClient, uploadBuffer } from '@/lib/cloudinary/server';
import { expiredReviewCases, updateCase } from '@/lib/firebase/repositories/verification';

/**
 * The ephemeral review buffer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL - read before "simplifying" it away
 * ---------------------------------------------------------------------------
 * Two requirements pull in opposite directions:
 *
 *   (a) delete identity documents immediately after the AI returns a verdict;
 *   (b) route ambiguous cases to a human moderator who approves or bans.
 *
 * A moderator cannot review an image that was deleted, so something has to
 * hold the bytes between the AI verdict and the human decision. Only
 * ambiguous cases reach this module; auto-approved and auto-rejected
 * submissions are wiped before the HTTP response is written.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE BYTES LIVE: CLOUDINARY, AUTHENTICATED DELIVERY
 * ---------------------------------------------------------------------------
 * Documents are uploaded server-side (signed with the API secret, which never
 * leaves the server) as `type: 'authenticated'` assets. An authenticated
 * asset has no public URL: every delivery must carry a signature only this
 * server can mint, so a leaked public ID or secure_url is useless on its own.
 * Firebase Storage is not involved, and Firestore stores identifiers only
 * (public ID, version, format, size, upload time) - never bytes or base64.
 *
 * ---------------------------------------------------------------------------
 * RETENTION: 7 DAYS FROM UPLOAD, ENFORCED IN THREE INDEPENDENT PLACES
 * ---------------------------------------------------------------------------
 * Cloudinary has no per-asset TTL, so expiry is enforced here, keyed on the
 * upload time Cloudinary itself recorded (`created_at`):
 *
 *   1. retrieve() refuses an expired buffer AND deletes it on the spot. This
 *      holds even if every scheduled job is dead.
 *   2. reapExpired() closes cases whose window lapsed, deleting the assets
 *      first and only then clearing the Firestore references, so a failed
 *      delete never leaves an orphan nothing points at.
 *   3. sweepExpiredAssets() lists every asset under the buffer prefix and
 *      deletes those whose Cloudinary `created_at` is older than the TTL. It
 *      does not need Firestore, so it also catches assets whose case row was
 *      lost, and because it compares each asset's own upload time a newer
 *      upload can never be swept early.
 *
 * (2) and (3) run from src/server/cron/scheduler.ts every 15 minutes and from
 * GET /api/cron/verification-cleanup for platform schedulers.
 */

/** Hard ceiling on the window. Deliberately not configurable upwards. */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Every buffered asset's public ID starts with this, and nothing else's does. */
const BUFFER_PREFIX = 'campushub/kyc-review';
const BUFFER_TAG = 'campushub_kyc_review';
const DELIVERY_TYPE = 'authenticated' as const;

export type BufferedDocument = {
  kind: string;
  mime: string;
  bytes: Buffer;
};

/** What Firestore holds for one buffered document: identifiers, never bytes. */
export type StoredReviewDocument = {
  kind: string;
  publicId: string;
  version: number;
  format: string;
  resourceType: 'image';
  deliveryType: typeof DELIVERY_TYPE;
  /** Unsigned authenticated URL - not deliverable without a server signature. */
  secureUrl: string;
  bytes: number;
  width: number | null;
  height: number | null;
  uploadedAt: Date;
};

export type ReviewBufferHandle = {
  /** Public-ID prefix shared by this case's assets. */
  key: string;
  expiresAt: Date;
  documents: StoredReviewDocument[];
};

function ttlSeconds(): number {
  const configured = Number(process.env.REVIEW_BUFFER_TTL_SECONDS ?? MAX_TTL_SECONDS);
  if (!Number.isFinite(configured)) return MAX_TTL_SECONDS;
  return Math.min(Math.max(configured, 300), MAX_TTL_SECONDS);
}

/** Accepts a Date, a Firestore Timestamp or an ISO string. */
function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  return new Date(value as string).getTime();
}

/**
 * Uploads the document set to Cloudinary and returns what the case row needs.
 *
 * The caller MUST wipe its own copies of `documents[].bytes` afterwards. A
 * partial failure deletes whatever did upload before rethrowing, so a failed
 * stash never leaves documents behind without a case pointing at them.
 */
export async function stash(documents: BufferedDocument[]): Promise<ReviewBufferHandle> {
  const key = `${BUFFER_PREFIX}/${randomUUID()}`;

  try {
    const stored = await Promise.all(
      documents.map(async (doc): Promise<StoredReviewDocument> => {
        const isPdf = doc.mime === 'application/pdf';
        const result = await uploadBuffer(doc.bytes, {
          public_id: `${key}/${doc.kind}`,
          resource_type: 'image',
          type: DELIVERY_TYPE,
          tags: [BUFFER_TAG],
          overwrite: false,
          // Cap the stored original: phone photos arrive at 12+ MP and a
          // reviewer never needs more. 'limit' never upscales; PDFs are kept
          // as submitted.
          ...(isPdf ? {} : { transformation: [{ width: 2400, height: 2400, crop: 'limit' }] }),
          timeout: 60_000,
        });

        const uploadedAt = new Date(result.created_at);
        return {
          kind: doc.kind,
          publicId: result.public_id,
          version: result.version,
          format: result.format,
          resourceType: 'image',
          deliveryType: DELIVERY_TYPE,
          // For an authenticated asset the upload response URL already carries
          // a NON-EXPIRING signature, i.e. it is a permanent public link to an
          // identity document. Strip it: what Firestore stores must not be
          // deliverable on its own - only retrieve() mints signed URLs.
          secureUrl: result.secure_url.replace(/\/s--[^/]+--\//, '/'),
          bytes: result.bytes,
          width: result.width ?? null,
          height: result.height ?? null,
          uploadedAt: Number.isNaN(uploadedAt.getTime()) ? new Date() : uploadedAt,
        };
      }),
    );

    // The window starts at the EARLIEST upload, so the case row and the asset
    // sweep, which reads each asset's own created_at, agree on the expiry.
    const earliest = Math.min(...stored.map((doc) => doc.uploadedAt.getTime()));
    return { key, documents: stored, expiresAt: new Date(earliest + ttlSeconds() * 1000) };
  } catch (error) {
    await destroy(key).catch(() => {});
    throw error;
  }
}

/**
 * Fetches the buffered documents for a moderator, server-side.
 *
 * Each image is delivered through a signed URL that never leaves this process,
 * as a size-capped JPEG (the first page, for a PDF) so the review console
 * renders every document the same way.
 *
 * Returns null when the window has elapsed or the assets are gone - a normal
 * outcome meaning "ask the user to resubmit", not an error.
 */
export async function retrieve(buffer: {
  key: string;
  expiresAt: Date | null;
  documents: StoredReviewDocument[] | null;
}): Promise<BufferedDocument[] | null> {
  const documents = buffer.documents ?? [];
  if (documents.length === 0) return null;

  const now = Date.now();
  const lapsed =
    (buffer.expiresAt !== null && toMillis(buffer.expiresAt) <= now) ||
    documents.some((doc) => toMillis(doc.uploadedAt) + ttlSeconds() * 1000 <= now);
  if (lapsed) {
    await destroy(buffer.key).catch((error) =>
      console.error('[reviewBuffer] failed to destroy expired %s', buffer.key, error),
    );
    return null;
  }

  const client = cloudinaryClient();
  const fetched = await Promise.all(
    documents.map(async (doc) => {
      const url = client.url(doc.publicId, {
        type: doc.deliveryType,
        resource_type: 'image',
        version: doc.version,
        sign_url: true,
        secure: true,
        format: 'jpg',
        transformation: [
          { width: 1600, height: 1600, crop: 'limit', quality: 'auto:good', page: 1 },
        ],
      });
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Cloudinary delivery returned ${response.status}`);
      return {
        kind: doc.kind,
        mime: 'image/jpeg',
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    }),
  );

  if (fetched.some((doc) => doc === null)) return null;
  return fetched as BufferedDocument[];
}

/**
 * Destroys every asset under a buffer key. Called the instant a moderator
 * decides, before the decision is written - if that write then fails, the
 * correct state is "documents gone, case reopened", never "documents linger".
 */
export async function destroy(key: string): Promise<void> {
  // Trailing slash: `.../abc/` must never match a sibling `.../abcd/`.
  await cloudinaryClient().api.delete_resources_by_prefix(`${key}/`, {
    type: DELIVERY_TYPE,
    resource_type: 'image',
    invalidate: true,
  });
}

/**
 * Closes cases whose review window lapsed. Deletes the assets FIRST and only
 * then clears the case's references, so the residue of a partial failure is a
 * case still pointing at its assets (retried next run), never an orphan.
 */
export async function reapExpired(): Promise<number> {
  const expired = await expiredReviewCases(new Date());
  if (expired.length === 0) return 0;

  let closed = 0;
  for (const kase of expired) {
    if (kase.reviewBufferKey) {
      try {
        await destroy(kase.reviewBufferKey);
      } catch (error) {
        console.error('[reviewBuffer] failed to destroy %s', kase.reviewBufferKey, error);
        continue;
      }
    }

    await updateCase(kase.id, {
      reviewBufferKey: null,
      reviewExpiresAt: null,
      reviewDocuments: null,
      status: 'REJECTED',
      publicMessageKey: 'verification.banner.resubmitRequired',
      failureCodes: ['REVIEW_WINDOW_EXPIRED'],
      decidedAt: new Date(),
    });
    closed += 1;
  }

  return closed;
}

/**
 * Deletes every buffered asset whose Cloudinary upload time is older than the
 * TTL, independently of Firestore. Assets uploaded after the cutoff are never
 * touched: the filter reads each asset's own `created_at`.
 */
export async function sweepExpiredAssets(now: Date = new Date()): Promise<number> {
  const api = cloudinaryClient().api;
  const cutoff = now.getTime() - ttlSeconds() * 1000;
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const page = await api.resources({
      type: DELIVERY_TYPE,
      resource_type: 'image',
      prefix: `${BUFFER_PREFIX}/`,
      max_results: 500,
      ...(cursor ? { next_cursor: cursor } : {}),
    });

    const stale = (page.resources as { public_id: string; created_at: string }[])
      .filter((asset) => {
        const created = Date.parse(asset.created_at);
        return Number.isFinite(created) && created <= cutoff;
      })
      .map((asset) => asset.public_id);

    for (let i = 0; i < stale.length; i += 100) {
      const result = await api.delete_resources(stale.slice(i, i + 100), {
        type: DELIVERY_TYPE,
        resource_type: 'image',
        invalidate: true,
      });
      deleted += Object.values(result.deleted ?? {}).filter((status) => status === 'deleted').length;
    }

    cursor = page.next_cursor;
  } while (cursor);

  return deleted;
}
