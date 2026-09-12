import { NextResponse, type NextRequest } from 'next/server';
import { NoteStatus } from '@/lib/enums';
import {
  findNoteById,
  hasPaidOrder,
  incrementDownloadCount,
  readNoteBytes,
} from '@/lib/firebase/repositories/notes';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/notes/:noteId/file - download the attachment.
 *
 * The bytes are never served from a public path. Notes are a paid product, so
 * "who may read this file" is an authorization decision made per request:
 *
 *   - the seller always may (it is their upload);
 *   - a buyer with a PAID order may;
 *   - anyone may, if the note is published and free;
 *   - staff may, because moderating a marketplace means opening what is sold.
 *
 * Everyone else gets 404 rather than 403. A 403 on a note id confirms the note
 * exists and that someone paid for it, which is not information a stranger
 * should be able to enumerate.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ noteId: string }> },
) {
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

  const { noteId } = await params;

  const note = await findNoteById(noteId);

  if (!note || !note.attachment) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const isSeller = note.sellerId === userId;
  const isStaff = viewer.role === 'MODERATOR' || viewer.role === 'ADMIN';
  const isFreeAndPublished = note.priceMinor === 0 && note.status === NoteStatus.PUBLISHED;

  let hasPurchased = false;
  if (!isSeller && !isStaff && !isFreeAndPublished) {
    // A keyed read: the order id is derived from (buyer, note), so the
    // "did you pay for this" question needs no query.
    hasPurchased = await hasPaidOrder(userId, note.id);
  }

  if (!isSeller && !isStaff && !isFreeAndPublished && !hasPurchased) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  /**
   * The bytes are fetched only AFTER the authorization decision.
   *
   * That ordering was free when the file was a column selected alongside the
   * row; now it is a separate Storage download, and doing it first would mean
   * pulling a 20 MB object for every caller who is about to be refused.
   */
  const bytes = await readNoteBytes(note);

  // Counted only for a genuine reader, so the figure on the listing means
  // something. The seller re-downloading their own upload is not a download.
  if (!isSeller && !isStaff) {
    await incrementDownloadCount(note.id);
  }

  const { fileName, mime } = note.attachment;

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': mime,
      // `attachment` and a quoted, sanitised filename: an inline HTML or SVG
      // response would execute in the site's origin. The filename was already
      // stripped of path characters on upload; quoting it here stops a comma
      // or semicolon from splitting the header.
      'Content-Disposition': `attachment; filename="${fileName.replace(/["\\]/g, '')}"`,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
