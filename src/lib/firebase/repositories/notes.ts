import type { NoteStatus, OrderStatus } from '@/lib/enums';
import { adminDb } from '../admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '../collections';
import { deleteAuthenticated, downloadAuthenticated, uploadBuffer } from '@/lib/cloudinary/server';
import { docToObject, docsToObjects, forFirestore, sortBy } from '../convert';

/**
 * The note marketplace: listings, their files, and the orders against them.
 *
 * ===========================================================================
 * THE FILE LEAVES THE DATABASE, THE METADATA DOES NOT
 * ===========================================================================
 * `note_attachments` was a separate TABLE holding a `bytes BYTEA` column, and
 * it was separate for one reason: so that listing notes never dragged fifty
 * megabytes per row through the query planner. Every `select` in the old code
 * therefore names `fileName, mime, sizeBytes` and pointedly omits `bytes`.
 *
 * Firestore forces the good version of that design rather than merely
 * permitting it - a document is capped at 1 MiB, so a 20 MB PDF cannot live in
 * one even if somebody wanted it to. The bytes go to Cloudinary as a raw,
 * authenticated asset; the note document carries the same three metadata
 * fields inline under `attachment`.
 *
 * Inline, and not a subcollection, because the metadata is read with the note
 * on EVERY listing and never on its own - the exact case a subcollection would
 * turn into an extra read per row. The reason `note_attachments` was a table
 * was the bytes, and the bytes are gone.
 *
 * ===========================================================================
 * ORDER IDS ARE DERIVED, WHICH IS WHAT MAKES A PURCHASE EXACTLY-ONCE
 * ===========================================================================
 * The SQL model carried TWO unique constraints on Order - `idempotencyKey` and
 * `(buyerId, noteId)` - and both existed to stop one thing: charging a buyer
 * twice for the same note when a form is double-submitted or a request is
 * retried after a timeout.
 *
 * Firestore has no unique indexes, so that guarantee cannot be declared. It
 * can, however, be made STRUCTURAL: the document id is derived from the buyer
 * and the note, so a second purchase is not a second row that a constraint
 * rejects - it is the same document id, and `create()` fails with
 * ALREADY_EXISTS. Unrepresentable beats forbidden.
 *
 * This also reproduces the old `idempotencyKey` exactly, because the key the
 * route derives (`order:<buyer>:<note>`) is the same tuple.
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
  /** First entry of universityIds; kept for older readers (admin, purchases). */
  universityId: string | null;
  /** Every university the note is tagged with. Absent on pre-multi-tag notes. */
  universityIds?: string[];
  courseCode: string | null;
  subject: string;
  language: string;
  academicYear: string | null;
  priceMinor: number;
  currency: string;
  status: NoteStatus;
  fileKey: string;
  fileSha256: string;
  sizeBytes: number;
  pageCount: number | null;
  previewKey: string | null;
  purchaseCount: number;
  ratingAvg: number;
  /** Unique reviewers: one noteReviews doc per verified buyer. */
  ratingCount: number;
  /** Sum of star values; lets creator averages be weighted exactly. */
  ratingSum?: number;
  rejectionReason: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  attachment: NoteAttachment | null;
};

export type OrderRecord = {
  id: string;
  buyerId: string;
  noteId: string;
  priceMinor: number;
  platformFeeMinor: number;
  sellerNetMinor: number;
  currency: string;
  status: OrderStatus;
  idempotencyKey: string;
  ledgerTxnId: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
};

const notes = () => adminDb().collection(COLLECTIONS.notes);
const orders = () => adminDb().collection(COLLECTIONS.orders);
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
 * The deterministic order id.
 *
 * A document id may not contain `/`, and must not be `.` or `..`. Both inputs
 * here are Firestore ids already, so the only transformation needed is the
 * separator - but the sanitiser stays, because an id that silently becomes a
 * path segment is a bug that would present as "purchases land in the wrong
 * collection", which is a horrible thing to debug.
 */
export function orderIdFor(buyerId: string, noteId: string): string {
  return `${buyerId}__${noteId}`.replace(/[/.]/g, '_');
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
 * `sort=trending` was `ORDER BY purchaseCount DESC, ratingAvg DESC,
 * publishedAt DESC` - three fields, which Firestore can only serve from a
 * composite index built for that exact tuple. Rather than commit the schema to
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
        (b.purchaseCount ?? 0) - (a.purchaseCount ?? 0) ||
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
 * exist is a listing whose download 404s for the buyer who paid for it. An
 * object with no document is invisible and collectable. Only one of those
 * costs a refund.
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
  priceMinor: number;
  universityIds: string[];
  status: NoteStatus;
  fileName: string;
  mime: string;
  sha256: string;
  bytes: Buffer;
}): Promise<NoteRecord> {
  // Cloudinary raw asset, authenticated delivery: never public. The file
  // route decides whether the caller is the seller, a paying buyer or staff.
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
    priceMinor: params.priceMinor,
    currency: 'AZN',
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
    purchaseCount: 0,
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

export async function findOrder(buyerId: string, noteId: string): Promise<OrderRecord | null> {
  return docToObject<OrderRecord>(
    await orders().doc(orderIdFor(buyerId, noteId)).get(),
  ) as OrderRecord | null;
}

/**
 * Has this buyer paid for this note?
 *
 * A keyed read rather than a query, because the id encodes the pair. This is
 * the check that gates every note download, so it sits on the hot path of the
 * one route where getting it wrong hands a paid product to a stranger.
 */
export async function hasPaidOrder(buyerId: string, noteId: string): Promise<boolean> {
  const order = await findOrder(buyerId, noteId);
  return order?.status === 'PAID';
}

export async function listOrdersForBuyer(
  buyerId: string,
  statuses: OrderStatus[],
  take = 100,
): Promise<OrderRecord[]> {
  const snap = await orders()
    .where('buyerId', '==', buyerId)
    .where('status', 'in', statuses)
    .limit(take)
    .get();
  return sortBy(docsToObjects<OrderRecord>(snap.docs) as OrderRecord[], 'createdAt', 'desc');
}

export async function countOrders(where: Record<string, unknown> = {}): Promise<number> {
  let query: FirebaseFirestore.Query = orders();
  for (const [field, value] of Object.entries(where)) query = query.where(field, '==', value);
  return (await query.count().get()).data().count;
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

/** Which of these notes the buyer holds a PAID order for. */
export async function findPaidNoteIds(buyerId: string, noteIds: string[]): Promise<Set<string>> {
  const snaps = await existingIds(noteIds.map((id) => orders().doc(orderIdFor(buyerId, id))));
  return new Set(snaps.filter((s) => s.data()?.status === 'PAID').map((s) => String(s.data()!.noteId)));
}

// ---------------------------------------------------------------- reviews

export class NoteReviewError extends Error {
  constructor(readonly messageKey: string, readonly status: number) {
    super(messageKey);
  }
}

/** The viewer's own star value per note, for pre-filling the rating control. */
export async function findViewerRatings(userId: string, noteIds: string[]): Promise<Map<string, number>> {
  const snaps = await existingIds(noteIds.map((id) => reviews().doc(orderIdFor(userId, id))));
  return new Map(snaps.filter((s) => s.exists).map((s) => [String(s.data()!.noteId), Number(s.data()!.rating)]));
}

/**
 * Creates or updates a buyer's rating.
 *
 * Review id = order id, so one buyer is one reviewer (ratingCount counts unique
 * reviewers) and a re-rate replaces rather than adds. The PAID-order read is
 * inside the transaction: a refund racing the review aborts and re-runs it.
 */
export async function upsertNoteReview(p: {
  userId: string;
  noteId: string;
  rating: number;
  body: string | null;
}): Promise<{ ratingAvg: number; ratingCount: number; rating: number }> {
  const db = adminDb();
  const id = orderIdFor(p.userId, p.noteId);
  const noteRef = notes().doc(p.noteId);
  const reviewRef = reviews().doc(id);

  return db.runTransaction(async (tx) => {
    const [orderSnap, noteSnap, reviewSnap] = await tx.getAll(orders().doc(id), noteRef, reviewRef);
    if (orderSnap.data()?.status !== 'PAID') {
      throw new NoteReviewError('notes.reviews.errors.purchaseRequired', 403);
    }
    if (!noteSnap.exists) throw new NoteReviewError('errors.notFound', 404);

    const note = noteSnap.data()!;
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
