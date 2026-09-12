import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import {
  createMediaAsset,
  findUnattachedByHash,
  newMediaId,
} from '@/lib/firebase/repositories/media';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import {
  IMAGE_REJECTION_KEY,
  MAX_IMAGE_BYTES,
  mediaStorageKey,
  processImage,
} from '@/lib/media/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Decoding and re-encoding a 12 MB image is CPU work, not a database wait.
export const maxDuration = 60;

/**
 * POST /api/media - upload one image, get back a storage key.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN UPLOAD ENDPOINT AND NOT A PRESIGN ENDPOINT
 * ---------------------------------------------------------------------------
 * The composer's original comment described a direct-to-S3 flow: call
 * /api/media/presign, PUT the bytes straight to the bucket, then send only the
 * returned key so image bytes never pass through the Next.js server. That is
 * the right design for a deployment with object storage, and it is not the
 * deployment this codebase has - S3_BUCKET_PUBLIC is named but no environment
 * carries AWS credentials, so a presign endpoint would hand the browser a URL
 * that 403s.
 *
 * More importantly, presigning is incompatible with the guarantee below.
 * Re-encoding is what strips EXIF GPS data and kills polyglot files, and it can
 * only happen somewhere that sees the bytes. A presigned PUT stores exactly
 * what the client sent, so a direct-to-S3 flow would need a post-upload Lambda
 * to do the same work - which is the same processing, just later and harder to
 * reason about.
 *
 * So the bytes come here, are validated and re-encoded, and are stored via the
 * same `db://` locator pattern note_attachments already uses. Moving to S3
 * later changes this handler and nothing above it: the client still receives a
 * `storageKey` and still sends only that to /api/feed.
 *
 * ---------------------------------------------------------------------------
 * THE TWO-STEP FLOW, AND WHY IT IS TWO STEPS
 * ---------------------------------------------------------------------------
 *   1. POST /api/media            -> { storageKey, width, height }
 *   2. POST /api/feed { media: [{ storageKey, width, height }] }
 *
 * Splitting them means a dropped connection during a 12 MB upload does not
 * lose the text the user has already typed, and it lets the composer show real
 * upload progress. The asset is created UNATTACHED; step 2 claims it. An asset
 * nobody claims is an orphan and is collectable - see the sweep note on the
 * model.
 */
export async function POST(request: NextRequest) {
  let userId: string;
  let viewer;
  try {
    ({ userId, viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  /**
   * Gated on the capability that will consume the result, not on a new one.
   *
   * Uploading is only ever a step toward posting, so a frozen account - which
   * cannot post - must not be able to fill the blob table either. The check
   * belongs here rather than only at step 2, or the storage cost is incurred
   * before the refusal.
   */
  if (!can(viewer, 'feed:post')) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  // Reuses the post budget: an image upload is part of composing a post, and a
  // separate allowance would just be a way around the posting limit.
  const rate = await rateLimit('feed:post', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json({ error: 'errors.unsupportedMediaType' }, { status: 415 });
  }

  // Content-Length is a client claim, so this is only a fast reject; the real
  // cap is enforced against the parsed bytes below.
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'feed.image.errors.tooLarge' }, { status: 413 });
  }

  const form = await request.formData();
  const entry = form.get('file');
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: 'feed.image.errors.missing' }, { status: 400 });
  }
  if (entry.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'feed.image.errors.tooLarge' }, { status: 413 });
  }

  const rawAlt = form.get('altText');
  const altText = typeof rawAlt === 'string' && rawAlt.trim() ? rawAlt.trim().slice(0, 300) : null;

  const input = Buffer.from(await entry.arrayBuffer());

  try {
    // Everything about the type and the dimensions is decided here, from the
    // bytes. `entry.type` is never consulted.
    const verdict = await processImage(input);
    if (!verdict.ok) {
      return NextResponse.json(
        { error: IMAGE_REJECTION_KEY[verdict.reason], reason: verdict.reason },
        { status: 400 },
      );
    }

    const { bytes, mime, width, height } = verdict.image;
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    /**
     * Same bytes, same owner, still unattached: hand back the existing asset.
     *
     * This makes a retried upload - the ordinary result of a flaky connection
     * and an impatient second tap - free instead of duplicating a multi-megabyte
     * blob. Scoped to the owner because two users posting the same meme are two
     * separate assets as far as deletion and attribution are concerned.
     */
    const existing = await findUnattachedByHash(userId, sha256);

    if (existing) {
      return NextResponse.json(
        {
          storageKey: mediaStorageKey(existing.id),
          mediaId: existing.id,
          width: existing.width,
          height: existing.height,
          mime,
          deduplicated: true,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    /**
     * The id is minted BEFORE the write, because the object path in Storage is
     * derived from it - the repository needs to know where the bytes go before
     * it can put them there. Firestore hands out ids client-side without a
     * round trip, so this costs nothing.
     */
    const asset = await createMediaAsset({
      id: newMediaId(),
      ownerId: userId,
      mime,
      width,
      height,
      sizeBytes: bytes.length,
      sha256,
      altText: altText ?? null,
      bytes,
    });

    return NextResponse.json(
      {
        storageKey: mediaStorageKey(asset.id),
        mediaId: asset.id,
        width,
        height,
        mime,
        sizeBytes: bytes.length,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[media] upload failed', error);
    return NextResponse.json({ error: 'feed.image.errors.uploadFailed' }, { status: 502 });
  } finally {
    // The original upload is not needed once it has been re-encoded. Ordinary
    // user content rather than KYC material, so this is hygiene rather than the
    // zero-retention rule - the same note as the notes route.
    input.fill(0);
  }
}
