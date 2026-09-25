import { NextResponse, type NextRequest } from 'next/server';
import { NoteStatus } from '@/lib/enums';
import { withAdmin } from '@/lib/auth/admin';
import { listNotesByStatus } from '@/lib/firebase/repositories/notes';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVIEWABLE = [NoteStatus.PENDING_REVIEW, NoteStatus.PUBLISHED, NoteStatus.REJECTED] as string[];

/**
 * GET /api/admin/notes?status=PENDING_REVIEW
 *
 * The moderation queue for uploaded notes. The file itself is opened through
 * the existing /api/notes/:noteId/file route, which already lets staff read
 * any note.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const requested = request.nextUrl.searchParams.get('status') ?? NoteStatus.PENDING_REVIEW;
    const status = REVIEWABLE.includes(requested) ? requested : NoteStatus.PENDING_REVIEW;

    const notes = await listNotesByStatus(status as NoteStatus);
    const [sellers, universities] = await Promise.all([
      findUsersByIds(notes.map((n) => n.sellerId)),
      findUniversitiesByIds(notes.map((n) => n.universityId).filter((id): id is string => Boolean(id))),
    ]);

    return NextResponse.json(
      {
        notes: notes.map((n) => {
          const seller = sellers.get(n.sellerId);
          return {
            id: n.id,
            title: n.title,
            description: n.description,
            subject: n.subject,
            status: n.status,
            createdAt: n.createdAt,
            rejectionReason: n.rejectionReason,
            university: n.universityId ? (universities.get(n.universityId)?.code ?? null) : null,
            seller: seller ? { nickname: seller.nickname, email: seller.email } : null,
            attachment: n.attachment
              ? { fileName: n.attachment.fileName, mime: n.attachment.mime, sizeBytes: n.attachment.sizeBytes }
              : null,
          };
        }),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
