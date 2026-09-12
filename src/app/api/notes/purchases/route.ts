import { NextResponse, type NextRequest } from 'next/server';
import { findNoteById, listOrdersForBuyer } from '@/lib/firebase/repositories/notes';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/notes/purchases - the notes this account has bought.
 *
 * Scoped to the caller by `buyerId` in the WHERE clause, which is the whole
 * authorization story and must stay in the query rather than in a filter
 * afterwards: an order list is a purchase history, and returning someone
 * else's would disclose both what they bought and what they paid.
 */
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

  const orders = await listOrdersForBuyer(userId, ['PAID', 'REFUNDED']);

  /**
   * The note, seller and university decorations, batched.
   *
   * Prisma resolved this with a nested include. Firestore cannot join, and one
   * lookup per order would be a hundred round trips on a full page - so the
   * notes are fetched first, then the distinct seller and university ids they
   * name are fetched in one batched read each.
   *
   * Still metadata only: the file's bytes are a Storage object, and a purchase
   * list must not download one per row.
   */
  const notes = await Promise.all(orders.map((o) => findNoteById(o.noteId)));
  const noteById = new Map(notes.filter((n) => n !== null).map((n) => [n!.id, n!]));

  const [sellers, universities] = await Promise.all([
    findUsersByIds([...noteById.values()].map((n) => n.sellerId)),
    findUniversitiesByIds(
      [...noteById.values()]
        .map((n) => n.universityId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]);

  return NextResponse.json(
    {
      orders: orders.map((o) => {
        const note = noteById.get(o.noteId) ?? null;
        const seller = note ? sellers.get(note.sellerId) : null;
        const university = note?.universityId ? universities.get(note.universityId) : null;

        return {
          id: o.id,
          status: o.status,
          priceMinor: o.priceMinor,
          currency: o.currency,
          paidAt: o.paidAt?.toISOString() ?? null,
          refundedAt: o.refundedAt?.toISOString() ?? null,
          createdAt: o.createdAt.toISOString(),
          note: note
            ? {
                id: note.id,
                title: note.title,
                subject: note.subject,
                courseCode: note.courseCode,
                pageCount: note.pageCount,
                university: university ? { code: university.code } : null,
                seller: seller
                  ? { nickname: seller.nickname, isVerified: seller.isVerified }
                  : null,
                attachment: note.attachment
                  ? {
                      fileName: note.attachment.fileName,
                      mime: note.attachment.mime,
                      sizeBytes: note.attachment.sizeBytes,
                    }
                  : null,
              }
            : null,
          // A refunded order keeps its row for the ledger but no longer grants
          // access, so the client is told explicitly rather than inferring it.
          downloadable: o.status === 'PAID',
        };
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
