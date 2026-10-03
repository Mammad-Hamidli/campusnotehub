import { MAX_SOURCE_IMAGE_BYTES, MAX_UPLOAD_BYTES } from './constants';

/**
 * Image uploads from the browser: shrink, send, and turn every failure into a
 * locale key.
 *
 * Client-only (canvas, createImageBitmap). The server still decodes and
 * re-encodes every byte (src/lib/media/images.ts), so nothing here is a
 * security check - it exists to get the file UNDER the platform's request
 * limit (see MAX_UPLOAD_BYTES) and to make a 12 MB phone photo a ~600 KB
 * upload instead of a slow one.
 */

/** Longest edge sent for a feed image. The server stores at most 1080 wide. */
export const FEED_UPLOAD_MAX_SIDE = 2160;
/** Avatars are stored as a 320px square. */
export const AVATAR_UPLOAD_MAX_SIDE = 1024;

/** A JPEG/PNG/WebP this small and within the edge limit is sent untouched. */
const SEND_AS_IS_BYTES = 1.5 * 1024 * 1024;

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * WebP keeps transparency; browsers that cannot encode it (Safari before 17)
 * hand back a PNG instead, so that case falls back to JPEG on white.
 */
async function encode(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);

  const webp = await toBlob(canvas, 'image/webp', quality);
  if (webp?.type === 'image/webp') return webp;

  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return toBlob(canvas, 'image/jpeg', quality);
}

/**
 * Downscales and re-encodes `file` when it is larger than it needs to be.
 *
 * Returns the original when it is already small, when it is a GIF (a canvas
 * keeps only the first frame of an animation), or when this browser cannot
 * decode it (HEIC outside Safari) - the server's answer is the right one then.
 * EXIF orientation is applied by createImageBitmap, and the canvas copy carries
 * no EXIF at all.
 */
export async function shrinkImage(file: File, maxSide: number): Promise<File> {
  if (file.type === 'image/gif') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }

  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SEND_AS_IS_BYTES) return file;

    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    let blob = await encode(bitmap, width, height, 0.9);
    if (blob && blob.size > MAX_UPLOAD_BYTES) blob = await encode(bitmap, width, height, 0.7);
    if (!blob || (scale === 1 && blob.size >= file.size)) return file;

    const extension = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], `${file.name.replace(/\.[^.]*$/, '') || 'image'}.${extension}`, { type: blob.type });
  } finally {
    bitmap.close();
  }
}

/**
 * Shrinks and POSTs one image as multipart `file`, resolving to the JSON body.
 *
 * Rejects with an Error whose message is a locale key, including for the
 * failures that never reach the handler: a dropped connection (fetch throws)
 * and a platform 413 with an HTML body.
 */
export async function uploadImage<T>(endpoint: string, file: File, maxSide: number): Promise<T> {
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error('feed.image.errors.tooLarge');

  const prepared = await shrinkImage(file, maxSide);
  if (prepared.size > MAX_UPLOAD_BYTES) throw new Error('feed.image.errors.tooLarge');

  const form = new FormData();
  form.append('file', prepared);

  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', body: form });
  } catch {
    throw new Error('feed.image.errors.uploadFailed');
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback = response.status === 413 ? 'feed.image.errors.tooLarge' : 'feed.image.errors.uploadFailed';
    throw new Error(typeof payload?.error === 'string' ? payload.error : fallback);
  }
  return payload as T;
}
