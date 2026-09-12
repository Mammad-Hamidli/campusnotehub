import { NextResponse, type NextRequest } from 'next/server';
import { findMediaAsset, readMediaBytes } from '@/lib/firebase/repositories/media';

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

  /**
   * An id, never a path.
   *
   * This mattered when the bytes were a database column and it matters MORE
   * now that they are a Storage object: the id is interpolated into an object
   * path by STORAGE_PATHS.postMedia(), so an id containing `../` or a slash
   * would be a genuine traversal into another prefix of the bucket. The
   * character class here is what makes that unrepresentable.
   */
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const asset = await findMediaAsset(mediaId);

  if (!asset) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // The object is private in Storage; this route is what serves it, exactly as
  // it did when the bytes lived in the database.
  const bytes = await readMediaBytes(asset);

  return new NextResponse(new Uint8Array(bytes), {
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
