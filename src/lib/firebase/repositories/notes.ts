import { FieldValue } from 'firebase-admin/firestore';
import type { NoteStatus } from '@/lib/enums';
import { adminDb } from '../admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '../collections';
import { deleteAuthenticated, downloadAuthenticated, uploadBuffer } from '@/lib/cloudinary/server';
import { docToObject, docsToObjects, forFirestore } from '../convert';

/**
 * Shared notes: listings and their files. Every published note is free to
 * read and download for any signed-in account - there is no marketplace.
 *
 * The bytes live in Cloudinary as a raw, authenticated asset; the note
 * document carries the metadata inline under `attachment`, because it is read
 * with the note on every listing and never on its own.
 */

export type NoteAttachment = {
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  /** Cloudinary public id (raw, authenticated delivery). */
  storagePath: string;
  storageVersion?: number | null;
};

export type NoteRecord = {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  /** First entry of universityIds; kept for older readers (admin). */
  universityId: string | null;
  /** Every university the note is tagged with. Absent on pre-multi-tag notes. */
  universityIds?: string[];
  courseCode: string | null;
  subject: string;
  language: string;
  academicYear: string | null;
  status: NoteStatus;
  fileKey: string;
  fileSha256: string;
  sizeBytes: number;
  pageCount: number | null;
  previewKey: string | null;
  /** Successful file downloads. Absent on notes written before it existed. */
  downloadCount?: number;
  ratingAvg: number;
  /** Unique reviewers: one noteReviews doc per reader. */
  ratingCount: number;
  /** Sum of star values; lets creator averages be weighted exactly. */
  ratingSum?: number;
  rejectionReason: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  attachment: NoteAttachment | null;
};

const notes = () => adminDb().collection(COLLECTIONS.notes);
const reviews = () => adminDb().collection(COLLECTIONS.noteReviews);
const saved = (userId: string) => adminDb().collection(SUBCOLLECTIONS.savedNotes(userId));

/** Tagged universities, tolerant of notes written before multi-tagging. */
export function noteUniversityIds(note: Pick<NoteRecord, 'universityId' | 'universityIds'>): string[] {
  return note.universityIds?.length ? note.universityIds : note.universityId ? [note.universityId] : [];
}

export function newNoteId(): string {
  return notes().doc().id;
}

/**
 * The review id: one per (reader, note), so a re-rate replaces rather than
 * adds. A document id may not contain `/` or be `.`/`..`, hence the sanitiser.
 */
export function reviewIdFor(userId: string, noteId: string): string {
  return `${userId}__${noteId}`.replace(/[/.]/g, '_');
}

export async function findNoteById(id: string): Promise<NoteRecord | null> {
  return docToObject<NoteRecord>(await notes().doc(id).get()) as NoteRecord | null;
}

export type NoteListFilter = {
  status?: NoteStatus;
  sellerId?: string;
  universityId?: string;
  subject?: string;
};

/**
 * The public listing.
 *
 * `sort=trending` is downloads, then rating, then recency - three fields,
 * which Firestore can only serve from a composite index built for that tuple. Rather than commit the schema to
 * one sort order, the equality filters (which ARE indexed) narrow the set and
 * the multi-key ordering runs over the narrowed page, the way ./convert.sortBy
 * documents.
 *
 * The scan ceiling is what keeps that honest: it is a bounded read, not a
 * collection scan, and the listing is capped at 50 rows by its own schema.
 */
const LIST_SCAN_CEILING = 500;

export async function listNotes(
  filter: NoteListFilter,
  sort: 'trending' | 'recent',
  take: number,
): Promise<NoteRecord[]> {
  let query: FirebaseFirestore.Query = notes();
  if (filter.status) query = query.where('status', '==', filter.status);
  if (filter.sellerId) query = query.where('sellerId', '==', filter.sellerId);
  if (filter.subject) query = query.where('subject', '==', filter.subject);

  const snap = await query.limit(LIST_SCAN_CEILING).get();
  let rows = docsToObjects<NoteRecord>(snap.docs) as NoteRecord[];
  // In memory: covers both `universityIds` (array) and legacy `universityId`
  // without an array-contains + status composite index.
  if (filter.universityId) {
    const wanted = filter.universityId;
    rows = rows.filter((n) => noteUniversityIds(n).includes(wanted));
  }

  if (sort === 'trending') {
    rows.sort(
      (a, b) =>
        (b.downloadCount ?? 0) - (a.downloadCount ?? 0) ||
        Number(b.ratingAvg ?? 0) - Number(a.ratingAvg ?? 0) ||
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    );
  } else {
    rows.sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? b.createdAt?.getTime() ?? 0) -
          (a.publishedAt?.getTime() ?? a.createdAt?.getTime() ?? 0) ||
        b.id.localeCompare(a.id),
    );
  }

  return rows.slice(0, take);
}

/** The duplicate guard: same seller, same bytes, already uploaded. */
export async function findNoteBySellerAndHash(
  sellerId: string,
  sha256: string,
): Promise<NoteRecord | null> {
  const snap = await notes()
    .where('sellerId', '==', sellerId)
    .where('fileSha256', '==', sha256)
    .limit(1)
    .get();
  return (docsToObjects<NoteRecord>(snap.docs)[0] as NoteRecord) ?? null;
}

/**
 * Creates a note and stores its file.
 *
 * BYTES FIRST, DOCUMENT SECOND - the same ordering, for the same reason, as
 * createMediaAsset(). A note document pointing at an object that does not
 * exist is a listing whose download 404s. An object with no document is
 * invisible and collectable, which is the harmless failure.
 *
 * The old code did both inside one Postgres transaction, which is not
 * available across Storage and Firestore. Ordering is the honest replacement,
 * and the failure it leaves behind is the harmless one.
 */
export async function createNote(params: {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  subject: string;
  courseCode?: string;
  academicYear?: string;
  language: string;
  universityIds: string[];
  status: NoteStatus;
  fileName: string;
  mime: string;
  sha256: string;
  bytes: Buffer;
}): Promise<NoteRecord> {
  // Cloudinary raw asset, authenticated delivery: never public. The file
  // route decides who may read it (any signed-in account once PUBLISHED).
  // (Firebase Storage is not provisioned for this project.)
  const extension = (params.fileName.split('.').pop() ?? 'bin').toLowerCase();
  const uploaded = await uploadBuffer(params.bytes, {
    public_id: 'campusnotehub/notes/' + params.id + '/document.' + extension,
    resource_type: 'raw',
    type: 'authenticated',
    tags: ['campusnotehub_note'],
    overwrite: false,
    timeout: 120_000,
  });
  const storagePath = uploaded.public_id;
  const storageVersion = uploaded.version;

  const now = new Date();
  const record = {
    sellerId: params.sellerId,
    title: params.title,
    description: params.description,
    subject: params.subject,
    courseCode: params.courseCode ?? null,
    academicYear: params.academicYear ?? null,
    language: params.language,
    universityId: params.universityIds[0] ?? null,
    universityIds: params.universityIds,
    status: params.status,
    // `fileKey` stays the logical locator the rest of the code talks in; it is
    // now genuinely an object key, which is what the old comment anticipated.
    fileKey: storagePath,
    fileSha256: params.sha256,
    sizeBytes: params.bytes.length,
    pageCount: null,
    previewKey: null,
    downloadCount: 0,
    ratingAvg: 0,
    ratingCount: 0,
    ratingSum: 0,
    rejectionReason: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
    attachment: {
      fileName: params.fileName,
      mime: params.mime,
      sizeBytes: params.bytes.length,
      sha256: params.sha256,
      storagePath,
      storageVersion,
    },
  };

  await notes().doc(params.id).set(forFirestore(record));
  return { id: params.id, ...record } as NoteRecord;
}

/** Reads the note file back for the download route. */
export async function readNoteBytes(note: NoteRecord): Promise<Buffer> {
  const path = note.attachment?.storagePath ?? note.fileKey;
  return downloadAuthenticated({
    publicId: path,
    resourceType: 'raw',
    version: note.attachment?.storageVersion ?? null,
  });
}

export async function updateNote(id: string, patch: Record<string, unknown>): Promise<void> {
  await notes()
    .doc(id)
    .update(forFirestore({ ...patch, updatedAt: new Date() }));
}

/** Deletes the note document AND its object. Used by account erasure. */
export async function deleteNote(note: NoteRecord): Promise<void> {
  const path = note.attachment?.storagePath ?? note.fileKey;
  if (path && !path.startsWith('db://')) {
    // The object may already be gone; a delete that finds nothing has done its
    // job, so a missing object is not a failure.
    await deleteAuthenticated(path, 'raw');
  }
  await notes().doc(note.id).delete();
}

/** Counts a download. Fire-and-forget: a failed counter never fails a download. */
export function recordNoteDownload(noteId: string): void {
  notes()
    .doc(noteId)
    .update({ downloadCount: FieldValue.increment(1) })
    .catch((error) => console.error('[notes] download counter failed', error));
}

/** Keyed batch read; `getAll()` with zero refs throws, hence the guard. */
async function existingIds(refs: FirebaseFirestore.DocumentReference[]) {
  if (refs.length === 0) return [];
  return adminDb().getAll(...refs);
}

export async function findNotesByIds(ids: string[]): Promise<NoteRecord[]> {
  const snaps = await existingIds([...new Set(ids)].map((id) => notes().doc(id)));
  return docsToObjects<NoteRecord>(snaps) as NoteRecord[];
}

// ---------------------------------------------------------------- reviews

export class NoteReviewError extends Error {
  constructor(readonly messageKey: string, readonly status: number) {
    super(messageKey);
  }
}

/** The viewer's own star value per note, for pre-filling the rating control. */
export async function findViewerRatings(userId: string, noteIds: string[]): Promise<Map<string, number>> {
  const snaps = await existingIds(noteIds.map((id) => reviews().doc(reviewIdFor(userId, id))));
  return new Map(snaps.filter((s) => s.exists).map((s) => [String(s.data()!.noteId), Number(s.data()!.rating)]));
}

/**
 * Creates or updates a reader's rating.
 *
 * One review per (reader, note) - see reviewIdFor() - so ratingCount counts
 * unique reviewers. Any signed-in reader may rate a PUBLISHED note except its
 * author, who would otherwise be able to inflate their own average.
 */
export async function upsertNoteReview(p: {
  userId: string;
  noteId: string;
  rating: number;
  body: string | null;
}): Promise<{ ratingAvg: number; ratingCount: number; rating: number }> {
  const db = adminDb();
  const id = reviewIdFor(p.userId, p.noteId);
  const noteRef = notes().doc(p.noteId);
  const reviewRef = reviews().doc(id);

  return db.runTransaction(async (tx) => {
    const [noteSnap, reviewSnap] = await tx.getAll(noteRef, reviewRef);
    if (!noteSnap.exists || noteSnap.get('status') !== 'PUBLISHED') {
      throw new NoteReviewError('errors.notFound', 404);
    }
    const note = noteSnap.data()!;
    if (note.sellerId === p.userId) throw new NoteReviewError('notes.reviews.errors.ownNote', 403);

    const previous = reviewSnap.exists ? Number(reviewSnap.data()!.rating) : null;
    const prevCount = Number(note.ratingCount ?? 0);
    const prevSum = Number(note.ratingSum ?? Number(note.ratingAvg ?? 0) * prevCount);
    const ratingCount = prevCount + (previous === null ? 1 : 0);
    const ratingSum = prevSum - (previous ?? 0) + p.rating;
    const ratingAvg = Math.round((ratingSum / ratingCount) * 100) / 100;
    const now = new Date();

    tx.set(reviewRef, {
      noteId: p.noteId,
      sellerId: note.sellerId,
      userId: p.userId,
      rating: p.rating,
      body: p.body,
      createdAt: reviewSnap.data()?.createdAt ?? now,
      updatedAt: now,
    });
    tx.update(noteRef, { ratingSum, ratingCount, ratingAvg });
    return { ratingAvg, ratingCount, rating: p.rating };
  });
}

export type CreatorStats = { ratingAvg: number; ratedFiles: number; reviewCount: number };

/**
 * `@handle 4.6⭐ (3 files for 27 total reviews)` for many sellers at once.
 *
 * Computed on read from PUBLISHED notes (sellerId `in`, single-field index,
 * projected to four fields) so deletions and takedowns never leave a stale
 * denormalised aggregate behind.
 */
export async function creatorStatsFor(sellerIds: string[]): Promise<Map<string, CreatorStats>> {
  const unique = [...new Set(sellerIds)].filter(Boolean);
  const chunks = Array.from({ length: Math.ceil(unique.length / 30) }, (_, i) => unique.slice(i * 30, i * 30 + 30));
  const snaps = await Promise.all(
    chunks.map((ids) =>
      notes().where('sellerId', 'in', ids).select('sellerId', 'status', 'ratingSum', 'ratingAvg', 'ratingCount').get(),
    ),
  );

  const acc = new Map<string, { sum: number; files: number; reviews: number }>();
  for (const doc of snaps.flatMap((s) => s.docs)) {
    const d = doc.data();
    const count = Number(d.ratingCount ?? 0);
    if (d.status !== 'PUBLISHED' || count === 0) continue;
    const a = acc.get(d.sellerId) ?? { sum: 0, files: 0, reviews: 0 };
    a.sum += Number(d.ratingSum ?? Number(d.ratingAvg ?? 0) * count);
    a.files += 1;
    a.reviews += count;
    acc.set(d.sellerId, a);
  }

  return new Map(
    unique.map((id) => {
      const a = acc.get(id);
      return [
        id,
        a
          ? { ratingAvg: Math.round((a.sum / a.reviews) * 10) / 10, ratedFiles: a.files, reviewCount: a.reviews }
          : { ratingAvg: 0, ratedFiles: 0, reviewCount: 0 },
      ];
    }),
  );
}

// ------------------------------------------------------------ saved notes

export async function setNoteSaved(userId: string, noteId: string, on: boolean): Promise<void> {
  const ref = saved(userId).doc(noteId);
  if (on) await ref.set({ noteId, createdAt: new Date() });
  else await ref.delete();
}

export async function findSavedNoteIds(userId: string, noteIds: string[]): Promise<Set<string>> {
  const snaps = await existingIds(noteIds.map((id) => saved(userId).doc(id)));
  return new Set(snaps.filter((s) => s.exists).map((s) => s.id));
}

/** Newest first. Single-field order on a subcollection: no composite index. */
export async function listSavedNoteIds(userId: string, take = 100): Promise<string[]> {
  const snap = await saved(userId).orderBy('createdAt', 'desc').limit(take).get();
  return snap.docs.map((d) => d.id);
}

/** Moderation queue: every note in one status, newest first. */
export async function listNotesByStatus(status: NoteStatus, take = 200): Promise<NoteRecord[]> {
  // Equality only, so no composite index; ordered in memory.
  const snap = await notes().where('status', '==', status).limit(take).get();
  return (docsToObjects<NoteRecord>(snap.docs) as NoteRecord[]).sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  );
}
