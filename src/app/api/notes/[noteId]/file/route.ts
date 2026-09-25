import { NextResponse, type NextRequest } from 'next/server';
import { NoteStatus } from '@/lib/enums';
import { findNoteById, readNoteBytes, recordNoteDownload } from '@/lib/firebase/repositories/notes';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/notes/:noteId/file - download the attachment.
 *
 * The ONLY path to a note's bytes. The asset is a Cloudinary `authenticated`
 * raw file whose signed URL is minted server-side (5 min) inside
 * readNoteBytes() and never sent to a browser, so there is no CDN link to
 * share or guess. Access, decided per request:
 *
 *   - any signed-in account, once the note is PUBLISHED (notes are free);
 *   - the author and staff, in any status (moderation, own drafts).
 *
 * Everyone else gets 404 (not 403), so unpublished note ids cannot be probed.
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

  const limit = await rateLimit('notes:download', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const { noteId } = await params;
  const note = await findNoteById(noteId);
  if (!note || !note.attachment) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const allowed =
    note.status === NoteStatus.PUBLISHED ||
    note.sellerId === userId ||
    viewer.role === 'MODERATOR' ||
    viewer.role === 'ADMIN';

  if (!allowed) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // Bytes only after the decision: no 10 MB fetch for a caller about to be refused.
  const bytes = await readNoteBytes(note);
  if (note.sellerId !== userId) recordNoteDownload(note.id);
  const { fileName, mime } = note.attachment;

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': mime,
      // `attachment` + sanitised name: inline HTML/SVG would run in our origin.
      'Content-Disposition': `attachment; filename="${fileName.replace(/["\\\r\n]/g, '')}"`,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
