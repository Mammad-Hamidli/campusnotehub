/**
 * Image constants shared by the browser and the server.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM images.ts
 * ---------------------------------------------------------------------------
 * `images.ts` imports sharp, which is a NATIVE Node addon. A React client
 * component that imports anything from that module pulls sharp - and through
 * it `child_process`, `fs` and detect-libc - into the browser bundle, and the
 * whole application stops compiling:
 *
 *   Module not found: Can't resolve 'child_process'
 *   ./node_modules/sharp/lib/utility.js
 *   ./src/lib/media/images.ts
 *   ./src/components/dashboard/Composer.tsx
 *
 * The failure is not confined to the composer either. Once that import exists,
 * every route that renders the dashboard fails, so the symptom is a
 * server-wide 500 rather than a broken image picker - which is exactly how it
 * showed up: signed-in pages 500ing and the admin guard appearing to let a
 * student through, because nothing was rendering at all.
 *
 * So anything the CLIENT needs - the size cap, the accept attribute, the key
 * format - lives here with no runtime dependencies, and images.ts imports and
 * re-exports it. The rule is simple: if a client component needs a value, it
 * belongs in this file.
 */

/** Hard ceiling on the encoded upload. Enforced again on the server. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB
export const MAX_IMAGE_MB = MAX_IMAGE_BYTES / (1024 * 1024);

export const ACCEPTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** The accept= attribute for the file input, derived from the same list. */
export const IMAGE_ACCEPT_ATTRIBUTE = [
  ...ACCEPTED_IMAGE_MIME,
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
].join(',');

/**
 * The logical locator stored on PostMedia.storageKey.
 *
 * `db://media/<id>` today; an object key if this ever moves to S3. The
 * indirection is the same one Note.fileKey uses, and it is why the client
 * translates a key to a URL in exactly one place.
 */
export const mediaStorageKey = (id: string) => `db://media/${id}`;

/** Parses that locator back to an id, or null if it is not one of ours. */
export function mediaIdFromKey(storageKey: string): string | null {
  const match = /^db:\/\/media\/([A-Za-z0-9_-]+)$/.exec(storageKey);
  return match ? match[1] : null;
}

/** Turns a stored key into a URL the browser can request. */
export function mediaUrlFromKey(storageKey: string): string {
  const id = mediaIdFromKey(storageKey);
  return id ? `/api/media/${id}` : storageKey;
}
