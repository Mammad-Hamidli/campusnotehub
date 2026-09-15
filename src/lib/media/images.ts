/**
 * Poisons this module for the browser.
 *
 * Importing it from a client component now fails AT BUILD TIME with an
 * explicit "you're importing a component that needs server-only" message,
 * instead of the symptom that actually occurred: sharp dragging
 * `child_process` into the client bundle, every signed-in page returning 500,
 * and the admin guard appearing to admit a student because nothing rendered
 * at all. Client code imports ./constants instead.
 */
import 'server-only';
import sharp from 'sharp';
import { ACCEPTED_IMAGE_MIME, FEED_IMAGE_HEIGHT, FEED_IMAGE_WIDTH, MAX_IMAGE_BYTES } from './constants';

/**
 * Re-exported so server code has one import for everything image-related,
 * while client components import ./constants directly and never reach sharp.
 * See the header of ./constants.ts for what happens when they do.
 */
export {
  ACCEPTED_IMAGE_MIME,
  IMAGE_ACCEPT_ATTRIBUTE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MB,
  mediaIdFromKey,
  mediaStorageKey,
  mediaUrlFromKey,
} from './constants';

/**
 * Post-image processing.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, SAME AS EVERY OTHER UPLOAD PATH IN THIS CODEBASE
 * ---------------------------------------------------------------------------
 * The decision is made from the BYTES. `file.type` is a string the browser
 * copies from the extension and an attacker sets it to whatever they like, so
 * it is cross-checked and never trusted. This mirrors
 * src/lib/verification/fileValidation.ts and src/lib/notes/fileTypes.ts rather
 * than inventing a third convention.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY IMAGE IS RE-ENCODED
 * ---------------------------------------------------------------------------
 * Nothing the client sent is ever stored or served. sharp decodes the image
 * and writes a fresh WebP, which buys three things at once:
 *
 *  1. EXIF IS DESTROYED. A phone photo carries GPS coordinates, the device
 *     serial, and the capture timestamp. Publishing the original bytes of a
 *     student's picture publishes where they took it - typically their home or
 *     their dorm room. This is the single most important line in the file.
 *  2. POLYGLOTS DIE. A file that is a valid GIF *and* a valid HTML document
 *     (the classic stored-XSS trick against an image host) does not survive a
 *     decode/re-encode round trip: the output is whatever the decoder saw as
 *     pixels, and nothing else.
 *  3. DECOMPRESSION BOMBS ARE BOUNDED. A 30,000x30,000 PNG is a few hundred
 *     kilobytes on disk and ~3.6 GB decoded. `limitInputPixels` makes sharp
 *     refuse it before allocating, rather than after.
 */


/** Smallest accepted input; below this it is an icon, not a photo. */
const MIN_DIMENSION = 32;

/**
 * Ceiling on DECODED pixels, enforced before sharp allocates a buffer.
 *
 * 50 megapixels is comfortably above any real camera a student owns and far
 * below the point where a crafted file exhausts the server's memory.
 */
const MAX_INPUT_PIXELS = 50_000_000;


export type ImageRejection =
  | 'FILE_EMPTY'
  | 'FILE_TOO_LARGE'
  | 'MIME_NOT_ALLOWED'
  | 'DIMENSIONS_TOO_SMALL'
  | 'DECODE_FAILED';

export type ProcessedImage = {
  bytes: Buffer;
  mime: 'image/webp';
  width: number;
  height: number;
};

export type ImageResult = { ok: true; image: ProcessedImage } | { ok: false; reason: ImageRejection };

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  bytes.every((b, i) => buffer[offset + i] === b);

/**
 * Identifies the container from its magic bytes.
 *
 * Returns null for anything unrecognised, which is refused. An allow-list of
 * signatures is the check; the declared MIME is not consulted at all here.
 */
function sniff(buffer: Buffer): (typeof ACCEPTED_IMAGE_MIME)[number] | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'; // GIF8
  // WebP is a RIFF container: "RIFF" .... "WEBP"
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

/**
 * Validates and re-encodes one uploaded image.
 *
 * Never throws for bad input - a malformed upload is a 400, not a 500, and a
 * decoder crash on hostile bytes must not take the route down with it.
 */
export async function processImage(input: Buffer): Promise<ImageResult> {
  if (input.length === 0) return { ok: false, reason: 'FILE_EMPTY' };
  if (input.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'FILE_TOO_LARGE' };

  const sniffed = sniff(input);
  if (!sniffed) return { ok: false, reason: 'MIME_NOT_ALLOWED' };

  try {
    const pipeline = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      // An animated GIF would otherwise be flattened to its first frame
      // silently; reading all pages lets the WebP encoder keep the animation.
      animated: sniffed === 'image/gif',
    });

    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) return { ok: false, reason: 'DECODE_FAILED' };
    if (metadata.width < MIN_DIMENSION || metadata.height < MIN_DIMENSION) {
      return { ok: false, reason: 'DIMENSIONS_TOO_SMALL' };
    }

    const bytes = await pipeline
      .rotate() // Applies the EXIF orientation flag BEFORE that metadata is dropped.
      // Strict uniform output: every feed image is exactly FEED_IMAGE_WIDTH x
      // FEED_IMAGE_HEIGHT. `cover` + `attention` crops to the most salient
      // region instead of letterboxing; small inputs are upscaled so the
      // stored size never varies.
      .resize({
        width: FEED_IMAGE_WIDTH,
        height: FEED_IMAGE_HEIGHT,
        fit: 'cover',
        // Saliency cropping is single-frame only; animated GIFs crop centred.
        position: sniffed === 'image/gif' ? 'centre' : sharp.strategy.attention,
      })
      .webp({ quality: 82 })
      .toBuffer();

    // Re-read from the OUTPUT rather than scaling the input dimensions in JS.
    // `fit: inside` rounds, so computed values drift by a pixel and every
    // aspect-ratio box downstream inherits the error.
    const out = await sharp(bytes, { animated: sniffed === 'image/gif' }).metadata();
    if (!out.width || !out.height) return { ok: false, reason: 'DECODE_FAILED' };

    return {
      ok: true,
      image: {
        bytes,
        mime: 'image/webp',
        width: out.width,
        // An animated WebP reports the height of every frame stacked, so the
        // per-frame height is what the layout actually needs.
        height: out.pageHeight ?? out.height,
      },
    };
  } catch {
    // Corrupt data, a truncated file, or the pixel limit tripping. All of them
    // are the user's problem to fix, not an error to page anyone about.
    return { ok: false, reason: 'DECODE_FAILED' };
  }
}

/** Locale keys, so a rejection tells the uploader what to actually do. */
export const IMAGE_REJECTION_KEY: Record<ImageRejection, string> = {
  FILE_EMPTY: 'feed.image.errors.empty',
  FILE_TOO_LARGE: 'feed.image.errors.tooLarge',
  MIME_NOT_ALLOWED: 'feed.image.errors.typeNotAllowed',
  DIMENSIONS_TOO_SMALL: 'feed.image.errors.tooSmall',
  DECODE_FAILED: 'feed.image.errors.decodeFailed',
};
