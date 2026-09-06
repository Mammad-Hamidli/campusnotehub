import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/media/:mediaId - serves one stored image.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT BEHIND A SESSION CHECK
 * ---------------------------------------------------------------------------
 * These are images attached to feed posts, and the feed itself is readable by
 * signed-out visitors on a PUBLIC post. Requiring a session here would break
 * the logged-out feed, and it would not actually protect anything: enforcing
 * per-post visibility on every <img> means a database round trip per image per
 * request, and the id is an unguessable cuid.
 *
 * That is a deliberate trade and it is worth naming honestly: an image
 * attached to a FOLLOWERS-only post is reachable by anyone who has its exact
 * URL. It is not enumerable and it is not linked from anywhere the viewer
 * could not already see, but it is not a permission boundary either. Nothing
 * sensitive is stored through this path - identity documents never reach
 * object storage or this table at all, by the zero-retention design - so the
 * exposure is the same class as an unlisted photo link.
 *
 * If per-post visibility ever has to be enforced on media, the fix is a signed,
 * expiring URL like presignNoteDownload() already issues for purchased notes,
 * not a session check bolted on here.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  const { mediaId } = await params;

  // A cuid, never a path. This endpoint reads a database row by id and touches
  // no filesystem, so there is no traversal surface to defend.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const asset = await db.mediaAsset.findUnique({
    where: { id: mediaId },
    select: { bytes: true, mime: true, sizeBytes: true, createdAt: true },
  });

  if (!asset) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      // The stored MIME, which was decided by the encoder on upload - never a
      // value that came from a client.
      'Content-Type': asset.mime,
      'Content-Length': String(asset.sizeBytes),
      /**
       * Immutable and long-lived: the id addresses one specific re-encoded
       * blob that is never rewritten in place, so a cached copy can never go
       * stale. Editing an image means uploading a new asset with a new id.
       */
      'Cache-Control': 'public, max-age=31536000, immutable',
      /**
       * Belt and braces against content sniffing.
       *
       * Every byte served here was produced by sharp's WebP encoder, so it
       * cannot be a polyglot - but this header is what guarantees a browser
       * will not re-interpret the response as HTML and execute it if that ever
       * stops being true.
       */
      'X-Content-Type-Options': 'nosniff',
      // Nothing served from this route should ever be treated as a document.
      'Content-Disposition': 'inline',
    },
  });
}
