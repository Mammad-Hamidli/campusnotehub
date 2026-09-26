/**
 * Image delivery for emails, in two modes, chosen by configuration.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO MODES
 * ---------------------------------------------------------------------------
 *   cid (default) - the bytes are attached to the message itself with a
 *     Content-ID and referenced as src="cid:logo". This needs no public
 *     hosting at all, which is what makes branded mail possible while the app
 *     is only running locally.
 *
 *   url - the src is built from EMAIL_ASSET_BASE_URL. Smaller messages (Gmail
 *     clips anything over ~102 KB) and the image is cacheable across sends.
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMIT OF cid MODE ON SERVERLESS - READ BEFORE DEPLOYING
 * ---------------------------------------------------------------------------
 * cid mode reads the files from disk at send time. On a normal Node server
 * (`next start`, a container, a VM) that is exactly right. On Vercel's
 * serverless functions, files under public/ are served by the CDN but are NOT
 * present in the function's filesystem, so the read fails, this module logs one
 * warning, and the layout falls back to its text-only variant - branded but
 * imageless mail. That is a safe degradation rather than a failure, but the
 * correct production setting there is EMAIL_ASSET_MODE=url.
 *
 * ---------------------------------------------------------------------------
 * A MISSING FILE IS NEVER AN ERROR
 * ---------------------------------------------------------------------------
 * Images are supplied by hand into public/email/, so at any moment some may be
 * absent. Every caller treats null as "render the text variant of this block".
 * This is not merely defensive: mail clients block images by default, so the
 * layout has to read correctly without them in any case.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { emailBranding } from './branding';

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  /** Referenced from the HTML as src="cid:<cid>". */
  cid: string;
  contentType: string;
};

export type ResolvedAsset = {
  /** Ready to place in a src attribute. */
  src: string;
  /** Present only in cid mode; the transport must attach it. */
  attachment?: EmailAttachment;
};

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Files are read once per process.
 *
 * A logo is attached to every single message, and re-reading it per send would
 * put a synchronous disk read in the path of every request that triggers mail.
 * `null` is cached too, so a missing file costs one failed stat for the life of
 * the process rather than one per email.
 */
const cache = new Map<string, Buffer | null>();
const warned = new Set<string>();

function warnOnce(filename: string, message: string) {
  if (warned.has(filename)) return;
  warned.add(filename);
  console.warn(`[email] ${message}`);
}

/** The logical Content-ID for a file, e.g. 'logo.png' -> 'logo'. */
const cidFor = (filename: string) => filename.replace(/\.[^.]+$/, '');

function readAsset(filename: string, dir: string): Buffer | null {
  const key = `${dir}|${filename}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Relative to the project root, which is process.cwd() under `next dev`,
  // `next start` and `tsx` alike.
  const path = isAbsolute(dir) ? join(dir, filename) : join(process.cwd(), dir, filename);

  let bytes: Buffer | null = null;
  try {
    bytes = readFileSync(path);
  } catch {
    bytes = null;
    warnOnce(
      key,
      `image "${filename}" not found in ${dir} - that block falls back to text. ` +
        'Add the file (see public/email/README.md) or set EMAIL_ASSET_MODE=url.',
    );
  }

  cache.set(key, bytes);
  return bytes;
}

/**
 * Resolves one image to something renderable, or null when it cannot be shown.
 *
 * @param filename a name documented in public/email/README.md, e.g. 'logo.png'
 */
export function resolveAsset(filename: string): ResolvedAsset | null {
  const { assetMode, assetDir, assetBaseUrl } = emailBranding();

  if (assetMode === 'url') {
    /**
     * No disk access on purpose. In url mode the images live on whatever host
     * serves assetBaseUrl, and that host is the authority on whether they
     * exist - checking the local working directory would report "missing" for
     * a file that is being served perfectly well from a CDN.
     */
    return { src: `${assetBaseUrl}/${filename}` };
  }

  const content = readAsset(filename, assetDir);
  if (!content) return null;

  const extension = (filename.split('.').pop() ?? '').toLowerCase();
  const cid = cidFor(filename);

  return {
    src: `cid:${cid}`,
    attachment: {
      filename,
      content,
      cid,
      contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
    },
  };
}

