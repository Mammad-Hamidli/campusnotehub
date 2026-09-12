import { FieldValue } from 'firebase-admin/firestore';
import type { NoteStatus, OrderStatus } from '@/lib/enums';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
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
  universityId: string | null;
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
  downloadCount: number;
  purchaseCount: number;
  ratingAvg: number;
  ratingCount: number;
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
  if (filter.universityId) query = query.where('universityId', '==', filter.universityId);
  if (filter.subject) query = query.where('subject', '==', filter.subject);

  const snap = await query.limit(LIST_SCAN_CEILING).get();
  const rows = docsToObjects<NoteRecord>(snap.docs) as NoteRecord[];

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
  universityId?: string;
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
    public_id: 'campushub/notes/' + params.id + '/document.' + extension,
    resource_type: 'raw',
    type: 'authenticated',
    tags: ['campushub_note'],
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
    universityId: params.universityId ?? null,
    status: params.status,
    // `fileKey` stays the logical locator the rest of the code talks in; it is
    // now genuinely an object key, which is what the old comment anticipated.
    fileKey: storagePath,
    fileSha256: params.sha256,
    sizeBytes: params.bytes.length,
    pageCount: null,
    previewKey: null,
    downloadCount: 0,
    purchaseCount: 0,
    ratingAvg: 0,
    ratingCount: 0,
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

export async function incrementDownloadCount(id: string): Promise<void> {
  await notes().doc(id).update({ downloadCount: FieldValue.increment(1) });
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

/** Moderation queue: every note in one status, newest first. */
export async function listNotesByStatus(status: NoteStatus, take = 200): Promise<NoteRecord[]> {
  // Equality only, so no composite index; ordered in memory.
  const snap = await notes().where('status', '==', status).limit(take).get();
  return (docsToObjects<NoteRecord>(snap.docs) as NoteRecord[]).sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  );
}
