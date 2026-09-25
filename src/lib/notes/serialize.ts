import {
  creatorStatsFor,
  findSavedNoteIds,
  findViewerRatings,
  noteUniversityIds,
  type NoteRecord,
} from '@/lib/firebase/repositories/notes';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';

/**
 * The public note card, shared by GET /api/notes and GET /api/notes/saved.
 *
 * Every decoration is a batched read (sellers, universities, creator stats,
 * viewer bookmarks, viewer ratings), so a page costs a fixed number of round
 * trips regardless of size. Notes are free: any signed-in viewer may download,
 * and /api/notes/[noteId]/file re-checks the session on every request.
 */
export async function serializeNotes(rows: NoteRecord[], viewerId: string | null) {
  const ids = rows.map((n) => n.id);
  const [sellers, universities, stats, saved, ratings] = await Promise.all([
    findUsersByIds(rows.map((n) => n.sellerId)),
    findUniversitiesByIds(rows.flatMap(noteUniversityIds)),
    creatorStatsFor(rows.map((n) => n.sellerId)),
    viewerId ? findSavedNoteIds(viewerId, ids) : Promise.resolve(new Set<string>()),
    viewerId ? findViewerRatings(viewerId, ids) : Promise.resolve(new Map<string, number>()),
  ]);

  return rows.map((n) => {
    const seller = sellers.get(n.sellerId);
    const tagged = noteUniversityIds(n)
      .map((id) => universities.get(id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => ({ id: u.id, code: u.code, nameEn: u.nameEn }));
    const isSeller = viewerId === n.sellerId;

    return {
      id: n.id,
      title: n.title,
      subject: n.subject,
      courseCode: n.courseCode,
      language: n.language,
      ratingAvg: Number(n.ratingAvg ?? 0),
      /** Unique reviewers (one review per reader). */
      ratingCount: n.ratingCount ?? 0,
      downloadCount: n.downloadCount ?? 0,
      pageCount: n.pageCount,
      publishedAt: n.publishedAt,
      createdAt: n.createdAt,
      university: tagged[0] ?? null,
      universities: tagged,
      seller: seller
        ? {
            id: seller.id,
            nickname: seller.nickname,
            isVerified: seller.isVerified,
            stats: stats.get(seller.id) ?? null,
          }
        : null,
      attachment: n.attachment
        ? { fileName: n.attachment.fileName, mime: n.attachment.mime, sizeBytes: n.attachment.sizeBytes }
        : null,
      viewerIsSeller: isSeller,
      viewerCanDownload: viewerId !== null,
      viewerSaved: saved.has(n.id),
      viewerRating: ratings.get(n.id) ?? null,
    };
  });
}

export type SerializedNote = Awaited<ReturnType<typeof serializeNotes>>[number];
