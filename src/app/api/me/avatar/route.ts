import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { AccountStatus } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findUserById, updateUser } from '@/lib/firebase/repositories/users';
import {
  createMediaAsset,
  deleteMediaAsset,
  findMediaAsset,
  newMediaId,
} from '@/lib/firebase/repositories/media';
import { IMAGE_REJECTION_KEY, MAX_IMAGE_BYTES, processAvatar } from '@/lib/media/images';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Avatars are served by the ordinary media route - see /api/media/[mediaId]. */
const AVATAR_URL = /^\/api\/media\/([A-Za-z0-9_-]{1,64})$/;
const avatarUrlFor = (mediaId: string) => `/api/media/${mediaId}`;

async function session(request: NextRequest) {
  try {
    return await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/**
 * Deletes the previous picture once the profile no longer points at it.
 * Only an asset this user OWNS - a hand-edited avatarUrl can never be used to
 * delete somebody else's image. Best effort: an orphan blob is harmless, a
 * failed profile update is not, so this never fails the request.
 */
async function releasePrevious(userId: string, previousUrl: string | null) {
  const id = previousUrl?.match(AVATAR_URL)?.[1];
  if (!id) return;
  const asset = await findMediaAsset(id);
  if (asset && asset.ownerId === userId) await deleteMediaAsset(asset).catch(() => {});
}

/**
 * POST /api/me/avatar - upload or replace the profile picture (multipart
 * `file`). The bytes are validated and re-encoded to a square WebP exactly
 * like post images (EXIF/GPS destroyed), stored as an already-attached media
 * asset, and the profile's avatarUrl is pointed at it.
 */
export async function POST(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  const { userId, viewer } = auth;

  // A frozen account keeps read access only; changing a public picture is a write.
  if (viewer.accountStatus !== AccountStatus.ACTIVE && viewer.accountStatus !== AccountStatus.RESTRICTED) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  const rate = await rateLimit('profile:avatar', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json({ error: 'errors.unsupportedMediaType' }, { status: 415 });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'feed.image.errors.tooLarge' }, { status: 413 });
  }

  const entry = (await request.formData()).get('file');
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: 'feed.image.errors.missing' }, { status: 400 });
  }
  if (entry.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'feed.image.errors.tooLarge' }, { status: 413 });
  }

  const input = Buffer.from(await entry.arrayBuffer());
  try {
    const verdict = await processAvatar(input);
    if (!verdict.ok) {
      return NextResponse.json({ error: IMAGE_REJECTION_KEY[verdict.reason] }, { status: 400 });
    }

    const { bytes, mime, width, height } = verdict.image;
    const user = await findUserById(userId);
    if (!user) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

    const asset = await createMediaAsset({
      id: newMediaId(),
      ownerId: userId,
      mime,
      width,
      height,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      altText: null,
      bytes,
      attached: true,
    });

    const avatarUrl = avatarUrlFor(asset.id);
    await updateUser(userId, { avatarUrl });
    await releasePrevious(userId, user.avatarUrl);

    return NextResponse.json({ avatarUrl }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[avatar] upload failed', error);
    return NextResponse.json({ error: 'feed.image.errors.uploadFailed' }, { status: 502 });
  } finally {
    input.fill(0);
  }
}

/** DELETE /api/me/avatar - back to the initials fallback. */
export async function DELETE(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

  const user = await findUserById(auth.userId);
  if (!user) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

  await updateUser(auth.userId, { avatarUrl: null });
  await releasePrevious(auth.userId, user.avatarUrl);
  return NextResponse.json({ avatarUrl: null });
}
