import 'server-only';
import { after } from 'next/server';
import { findUserById, setAvatarIfEmpty } from '@/lib/firebase/repositories/users';
import { deleteMediaAsset } from '@/lib/firebase/repositories/media';
import { AVATAR_SIZE, processAvatar } from './images';
import { avatarUrlFor, storeAvatar } from './avatars';
import { avatarSourceUrl, withPhotoSize } from './avatar-source';

/**
 * One-time import of the provider's profile photo into a new account.
 *
 * ---------------------------------------------------------------------------
 * BEST EFFORT, AFTER THE RESPONSE
 * ---------------------------------------------------------------------------
 * Runs in `after()`, so the sign-in redirect never waits for Google's image
 * host, and nothing here can fail a sign-in: every outcome, including an
 * exception, resolves to a result. The worst case is the initials fallback the
 * account would have had anyway.
 *
 * ---------------------------------------------------------------------------
 * A COPY, NEVER A LINK
 * ---------------------------------------------------------------------------
 * The bytes go through processAvatar() - sniffed, re-encoded to WebP, EXIF
 * gone - and are stored like an uploaded picture (./avatars.ts), so the
 * profile points at /api/media/<id>. Hotlinking the Google URL would tell
 * Google who looks at whose profile, and break when the person changes photo.
 *
 * ---------------------------------------------------------------------------
 * NEVER OVER AN EXISTING PICTURE
 * ---------------------------------------------------------------------------
 * Checked before the download, and again in the same transaction that sets
 * it (setAvatarIfEmpty): the owner may upload a picture while this runs, and
 * theirs wins. The imported copy is then deleted.
 */

const FETCH_TIMEOUT_MS = 5_000;
/** Google account photos at 320px are tens of kilobytes; this is generous. */
export const REMOTE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type AvatarImportResult = 'imported' | 'skipped' | 'rejected' | 'failed';

/**
 * The body, or null when it is not a successful response within the size cap.
 * Redirects are refused outright: a redirect is a second URL the allowlist
 * never saw.
 */
async function download(url: URL): Promise<Buffer | null> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'image/webp,image/png,image/jpeg' },
    cache: 'no-store',
  });
  if (!response.ok || !response.body) return null;

  if (Number(response.headers.get('content-length') ?? 0) > REMOTE_AVATAR_MAX_BYTES) {
    await response.body.cancel().catch(() => {});
    return null;
  }

  // Counted while streaming: a missing or lying content-length must not let
  // an unbounded body into memory.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > REMOTE_AVATAR_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function importProviderAvatar(userId: string, picture: string | null): Promise<AvatarImportResult> {
  const source = avatarSourceUrl(picture);
  if (!source) return 'skipped';

  try {
    const user = await findUserById(userId);
    if (!user || user.avatarUrl) return 'skipped';

    const bytes = await download(withPhotoSize(source, AVATAR_SIZE));
    if (!bytes) return 'rejected';
    const verdict = await processAvatar(bytes);
    if (!verdict.ok) return 'rejected';

    const asset = await storeAvatar(userId, verdict.image);
    if (await setAvatarIfEmpty(userId, avatarUrlFor(asset.id))) return 'imported';

    await deleteMediaAsset(asset).catch(() => {});
    return 'skipped';
  } catch (error) {
    // Never the URL: it identifies the Google account.
    console.warn('[avatar] provider photo import failed:', error instanceof Error ? error.message : 'unknown');
    return 'failed';
  }
}

/**
 * Schedules the import without delaying the response. Call it once the
 * account exists. Outside a request (scripts, tests) `after()` throws, and the
 * import simply runs as a background promise - the same arrangement as
 * sendEmailAsync().
 */
export function importProviderAvatarAsync(userId: string, picture: string | null): void {
  if (!avatarSourceUrl(picture)) return;
  const task = async () => {
    await importProviderAvatar(userId, picture);
  };
  try {
    after(task);
  } catch {
    void task();
  }
}
