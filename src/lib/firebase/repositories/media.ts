import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { deleteAuthenticated, downloadAuthenticated, uploadBuffer } from '@/lib/cloudinary/server';
import { docToObject, forFirestore } from '../convert';

/**
 * Uploaded image assets.
 *
 * ===========================================================================
 * THE BYTES ARE IN STORAGE, THE METADATA IS IN FIRESTORE
 * ===========================================================================
 * `media_assets.bytes` was a BYTEA column. A Firestore document is capped at
 * 1 MiB and an uploaded photo routinely exceeds that even after re-encoding,
 * so the pixels live in Cloudinary (campushub/media/<id>, authenticated) and the
 * document holds only what a query needs: owner, mime, dimensions, hash and
 * the attachment state.
 *
 * Authenticated assets have no public URL, so the bytes are served through the
 * existing /api/media/[mediaId] route exactly as they were when they lived in
 * the database. No object is ever made public, and no signed URL is handed
 * out - the route is what applies the ownership and visibility rules.
 */

export type MediaAssetRecord = {
  id: string;
  ownerId: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  altText: string | null;
  /** Cloudinary public id (authenticated delivery). */
  storagePath: string;
  storageVersion?: number | null;
  storageFormat?: string | null;
  attachedAt: Date | null;
  createdAt: Date;
};

const assets = () => adminDb().collection(COLLECTIONS.mediaAssets);

export function newMediaId(): string {
  return assets().doc().id;
}

/**
 * Same bytes, same owner, still unattached.
 *
 * Three equality filters, which Firestore indexes natively - the SQL
 * `findFirst` becomes a bounded query rather than an in-memory scan. Scoped to
 * the owner because two users posting the same meme are two separate assets as
 * far as deletion and attribution are concerned.
 */
export async function findUnattachedByHash(
  ownerId: string,
  sha256: string,
): Promise<MediaAssetRecord | null> {
  const snap = await assets()
    .where('ownerId', '==', ownerId)
    .where('sha256', '==', sha256)
    .where('attachedAt', '==', null)
    .limit(1)
    .get();
  const [doc] = snap.docs;
  return doc ? (docToObject<MediaAssetRecord>(doc) as MediaAssetRecord) : null;
}

export async function findMediaAsset(id: string): Promise<MediaAssetRecord | null> {
  return docToObject<MediaAssetRecord>(await assets().doc(id).get()) as MediaAssetRecord | null;
}

/** Writes the bytes to Storage, then the metadata document that points at them. */
export async function createMediaAsset(params: {
  id: string;
  ownerId: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  altText: string | null;
  bytes: Buffer;
}): Promise<MediaAssetRecord> {
  /**
   * Cloudinary, authenticated delivery: never publicly addressable - the bytes
   * are served by /api/media/[mediaId], which applies the visibility rules.
   *
   * This used to be a Firebase Storage write. The project has no Storage
   * bucket provisioned, so every save() failed with a 404 and the composer
   * showed "Şəkil yüklənmədi" for every image, whatever its size or type.
   */
  const uploaded = await uploadBuffer(params.bytes, {
    public_id: 'campushub/media/' + params.id,
    resource_type: 'image',
    type: 'authenticated',
    tags: ['campushub_media'],
    overwrite: false,
    timeout: 60_000,
  });
  const storagePath = uploaded.public_id;

  const record = {
    ownerId: params.ownerId,
    mime: params.mime,
    width: params.width,
    height: params.height,
    sizeBytes: params.sizeBytes,
    sha256: params.sha256,
    altText: params.altText,
    storagePath,
    storageVersion: uploaded.version,
    storageFormat: uploaded.format,
    attachedAt: null,
    createdAt: new Date(),
  };

  await assets().doc(params.id).set(forFirestore(record));
  return { id: params.id, ...record };
}

/** Reads the pixels back for /api/media/[mediaId]. */
export async function readMediaBytes(asset: MediaAssetRecord): Promise<Buffer> {
  return downloadAuthenticated({
    publicId: asset.storagePath,
    resourceType: 'image',
    version: asset.storageVersion ?? null,
    format: asset.storageFormat ?? null,
  });
}

export type ClaimResult =
  | { ok: true; assets: MediaAssetRecord[] }
  | { ok: false };

/**
 * Claims assets for a post: they must exist, belong to this user, and not
 * already be attached.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TRANSACTION AND NOT THREE READS AND AN UPDATE
 * ---------------------------------------------------------------------------
 * All three conditions matter and none can be skipped:
 *  - existence, or a post carries a key that 404s as a broken image;
 *  - ownership, or anyone can attach a stranger's image to their own post
 *    simply by quoting its key, which is both theft and a way to put someone
 *    else's photo under text they never wrote;
 *  - unattached, so one upload cannot be fanned out across many posts and a
 *    later deletion has one place to clean up.
 *
 * The third is a check-then-act, and checking outside a transaction would let
 * two simultaneous posts both observe `attachedAt == null` and both proceed.
 * Firestore aborts and retries a transaction whose read set changed before
 * commit, which is exactly what closes that race - the same guarantee the SQL
 * version got from doing the update inside its transaction.
 *
 * Returns a single `ok: false` for every failure. Distinguishing "no such
 * asset" from "not yours" from "already used" would tell a caller which keys
 * exist.
 */
export async function claimMediaAssets(ids: string[], ownerId: string): Promise<ClaimResult> {
  if (ids.length === 0) return { ok: true, assets: [] };

  // A repeated id would be claimed twice in one post; refuse rather than
  // silently de-duplicate, since the request is malformed either way.
  if (new Set(ids).size !== ids.length) return { ok: false };

  try {
    const claimed = await adminDb().runTransaction(async (tx) => {
      const refs = ids.map((id) => assets().doc(id));
      const snaps = await tx.getAll(...refs);

      const records: MediaAssetRecord[] = [];
      for (const snap of snaps) {
        const asset = docToObject<MediaAssetRecord>(snap) as MediaAssetRecord | null;
        if (!asset) throw new ClaimRejected();
        if (asset.ownerId !== ownerId) throw new ClaimRejected();
        if (asset.attachedAt) throw new ClaimRejected();
        records.push(asset);
      }

      const now = new Date();
      for (const ref of refs) tx.update(ref, forFirestore({ attachedAt: now }));

      // Returned in the order the caller asked for, which is the order the
      // user arranged the images in and which getAll preserves.
      return records;
    });

    return { ok: true, assets: claimed };
  } catch (error) {
    if (error instanceof ClaimRejected) return { ok: false };
    throw error;
  }
}

/** Internal sentinel: aborts the claim transaction without a retry loop. */
class ClaimRejected extends Error {}

/**
 * Abandoned uploads, for the sweep.
 *
 * An asset still unattached after the window is an upload whose author closed
 * the tab, and must not become a permanent orphan blob.
 */
export async function listAbandonedAssets(olderThan: Date, take = 500) {
  const snap = await assets()
    .where('attachedAt', '==', null)
    .where('createdAt', '<', olderThan)
    .limit(take)
    .get();
  return snap.docs
    .map((doc) => docToObject<MediaAssetRecord>(doc))
    .filter((a): a is MediaAssetRecord => a !== null);
}

export async function deleteMediaAsset(asset: MediaAssetRecord): Promise<void> {
  // The file first: a document with no file is a broken image, a file with no
  // document is merely unreferenced. Delete in the order that never leaves
  // the visible fault.
  await deleteAuthenticated(asset.storagePath, 'image');
  await assets().doc(asset.id).delete();
}
