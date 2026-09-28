import 'server-only';
import { createHash } from 'node:crypto';
import {
  createMediaAsset,
  deleteMediaAsset,
  findMediaAsset,
  newMediaId,
  type MediaAssetRecord,
} from '@/lib/firebase/repositories/media';
import type { ProcessedImage } from './images';

/**
 * Profile-picture storage, shared by the upload route (/api/me/avatar) and the
 * one-time import of a provider photo (./import-avatar.ts), so both produce
 * the same kind of asset, owned and addressed the same way.
 */

/** Avatars are served by the ordinary media route - see /api/media/[mediaId]. */
const AVATAR_URL = /^\/api\/media\/([A-Za-z0-9_-]{1,64})$/;
export const avatarUrlFor = (mediaId: string) => `/api/media/${mediaId}`;

/**
 * Stores a processAvatar() result as an ALREADY-ATTACHED media asset: a
 * profile picture is in use the moment it is saved, so the abandoned-upload
 * sweep must never collect it.
 */
export async function storeAvatar(ownerId: string, image: ProcessedImage): Promise<MediaAssetRecord> {
  const { bytes, mime, width, height } = image;
  return createMediaAsset({
    id: newMediaId(),
    ownerId,
    mime,
    width,
    height,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    altText: null,
    bytes,
    attached: true,
  });
}

/**
 * Deletes a picture once the profile no longer points at it.
 * Only an asset this user OWNS - a hand-edited avatarUrl can never be used to
 * delete somebody else's image. Best effort: an orphan blob is harmless, a
 * failed profile update is not, so this never throws.
 */
export async function releaseAvatar(userId: string, url: string | null): Promise<void> {
  const id = url?.match(AVATAR_URL)?.[1];
  if (!id) return;
  const asset = await findMediaAsset(id).catch(() => null);
  if (asset && asset.ownerId === userId) await deleteMediaAsset(asset).catch(() => {});
}
