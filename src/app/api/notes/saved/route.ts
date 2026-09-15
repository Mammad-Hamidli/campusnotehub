import { NextResponse, type NextRequest } from 'next/server';
import { NoteStatus } from '@/lib/enums';
import { findNotesByIds, listSavedNoteIds } from '@/lib/firebase/repositories/notes';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { serializeNotes } from '@/lib/notes/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/notes/saved - the caller's bookmarked notes, newest save first. */
export async function GET(request: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const ids = await listSavedNoteIds(userId);
  const byId = new Map((await findNotesByIds(ids)).map((n) => [n.id, n]));
  // Keep save order; silently drop notes since unpublished or deleted.
  const rows = ids.map((id) => byId.get(id)).filter((n) => n?.status === NoteStatus.PUBLISHED);

  return NextResponse.json(
    { notes: await serializeNotes(rows as NonNullable<(typeof rows)[number]>[], userId) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
