import { NextResponse, type NextRequest } from 'next/server';
import { NoteStatus } from '@/lib/enums';
import { findNoteById, setNoteSaved } from '@/lib/firebase/repositories/notes';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT    /api/notes/:noteId/save - bookmark ("Save for later")
 * DELETE /api/notes/:noteId/save - remove bookmark
 *
 * Idempotent: the bookmark doc id is the note id.
 */
async function handle(request: NextRequest, noteId: string, on: boolean) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const limit = await rateLimit('notes:save', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  // Only listed notes can be saved; un-saving always works (note may be gone).
  if (on) {
    const note = await findNoteById(noteId);
    if (!note || note.status !== NoteStatus.PUBLISHED) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
  }

  await setNoteSaved(userId, noteId, on);
  return NextResponse.json({ noteId, saved: on }, { headers: { 'Cache-Control': 'no-store' } });
}

type Ctx = { params: Promise<{ noteId: string }> };

export async function PUT(request: NextRequest, { params }: Ctx) {
  return handle(request, (await params).noteId, true);
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  return handle(request, (await params).noteId, false);
}
