import { NextResponse, type NextRequest } from 'next/server';
import { NoteStatus, OrderStatus } from '@prisma/client';
import { db } from '@/lib/db';
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

  const note = await db.note.findUnique({
    where: { id: noteId },
    select: {
      id: true,
      sellerId: true,
      status: true,
      priceMinor: true,
      attachment: { select: { fileName: true, mime: true, sizeBytes: true, bytes: true } },
    },
  });

  if (!note || !note.attachment) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const isSeller = note.sellerId === userId;
  const isStaff = viewer.role === 'MODERATOR' || viewer.role === 'ADMIN';
  const isFreeAndPublished = note.priceMinor === 0 && note.status === NoteStatus.PUBLISHED;

  let hasPurchased = false;
  if (!isSeller && !isStaff && !isFreeAndPublished) {
    const order = await db.order.findFirst({
      where: { noteId: note.id, buyerId: userId, status: OrderStatus.PAID },
      select: { id: true },
    });
    hasPurchased = Boolean(order);
  }

  if (!isSeller && !isStaff && !isFreeAndPublished && !hasPurchased) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // Counted only for a genuine reader, so the figure on the listing means
  // something. The seller re-downloading their own upload is not a download.
  if (!isSeller && !isStaff) {
    await db.note.update({
      where: { id: note.id },
      data: { downloadCount: { increment: 1 } },
    });
  }

  const { fileName, mime, bytes } = note.attachment;

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': mime,
      // `attachment` and a quoted, sanitised filename: an inline HTML or SVG
      // response would execute in the site's origin. The filename was already
      // stripped of path characters on upload; quoting it here stops a comma
      // or semicolon from splitting the header.
      'Content-Disposition': `attachment; filename="${fileName.replace(/["\\]/g, '')}"`,
      'Content-Length': String(note.attachment.sizeBytes),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
