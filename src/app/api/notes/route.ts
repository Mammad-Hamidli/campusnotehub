import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { NoteStatus } from '@/lib/enums';
import { z } from 'zod';
import {
  createNote,
  findNoteBySellerAndHash,
  listNotes,
  newNoteId,
} from '@/lib/firebase/repositories/notes';
import { findUserById, findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { can } from '@/lib/permissions';
import {
  MAX_NOTE_BYTES,
  NOTE_UPLOAD_MIME,
  REJECTION_KEY,
  validateNoteFile,
} from '@/lib/notes/fileTypes';
import { sendEmailAsync } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/notes - the note listing.
 *
 * `?sort=trending` backs the "Populyar konspektlər" sidebar, which previously
 * rendered a hardcoded array of four invented notes with invented ratings and
 * purchase counts. Trending is ordered by real purchases, then rating, then
 * recency - so an empty database correctly shows an empty panel rather than
 * fiction.
 *
 * Only PUBLISHED notes are listed. Drafts and rejected uploads belong to their
 * seller alone.
 */
const listSchema = z.object({
  sort: z.enum(['trending', 'recent']).default('recent'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  universityId: z.string().optional(),
  subject: z.string().max(80).optional(),
});

export async function GET(request: NextRequest) {
  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { sort, limit, universityId, subject } = parsed.data;

  const notes = await listNotes(
    { status: NoteStatus.PUBLISHED, universityId, subject },
    sort,
    limit,
  );

  /**
   * The seller and university decorations, as TWO batched reads.
   *
   * Prisma resolved these with a join. Firestore cannot, and the naive
   * translation - a lookup per row - would turn a 20-item listing into 41
   * round trips. Collecting the distinct ids first and fetching them in one
   * `getAll` keeps it at three reads regardless of page size, which is the
   * same shape the feed serialiser already uses.
   */
  const [sellers, universities] = await Promise.all([
    findUsersByIds(notes.map((n) => n.sellerId)),
    findUniversitiesByIds(
      notes.map((n) => n.universityId).filter((id): id is string => Boolean(id)),
    ),
  ]);

  return NextResponse.json(
    {
      notes: notes.map((n) => {
        const seller = sellers.get(n.sellerId);
        const university = n.universityId ? universities.get(n.universityId) : null;
        return {
          id: n.id,
          title: n.title,
          subject: n.subject,
          courseCode: n.courseCode,
          language: n.language,
          priceMinor: n.priceMinor,
          currency: n.currency,
          ratingAvg: Number(n.ratingAvg),
          ratingCount: n.ratingCount,
          purchaseCount: n.purchaseCount,
          downloadCount: n.downloadCount,
          pageCount: n.pageCount,
          publishedAt: n.publishedAt,
          createdAt: n.createdAt,
          university: university
            ? { id: university.id, code: university.code, nameEn: university.nameEn }
            : null,
          seller: seller
            ? { id: seller.id, nickname: seller.nickname, isVerified: seller.isVerified }
            : null,
          // Metadata only. The bytes are a Storage object and are served by
          // /api/notes/[noteId]/file after an authorization check.
          attachment: n.attachment
            ? {
                fileName: n.attachment.fileName,
                mime: n.attachment.mime,
                sizeBytes: n.attachment.sizeBytes,
              }
            : null,
        };
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const createSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(4000),
  subject: z.string().trim().min(2).max(80),
  courseCode: z.string().trim().max(32).optional(),
  academicYear: z.string().trim().max(16).optional(),
  language: z.enum(['az', 'en', 'ru']).default('az'),
  /** Minor units (qepik). 0 means a free note. */
  priceMinor: z.coerce.number().int().min(0).max(100_000).default(0),
  universityId: z.string().optional(),
});

/**
 * POST /api/notes - create a note with its file.
 *
 * Multipart, read into memory under a hard cap, validated against the actual
 * bytes, then written to Postgres in one transaction with the note row. There
 * is no separate "upload then attach" step: a two-phase flow leaves orphaned
 * blobs behind whenever the second call fails, and nothing would ever collect
 * them.
 */
export async function POST(request: NextRequest) {
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

  const limit = await rateLimit('notes:upload', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  /**
   * Selling requires a verified identity. This is the existing capability
   * table, not a new rule - see REQUIRES_VERIFICATION in src/lib/permissions.ts
   * for why earning money is gated where spending it is not.
   */
  if (!can(viewer, 'notes:sell')) {
    return NextResponse.json({ error: 'errors.verificationRequired' }, { status: 403 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json({ error: 'errors.unsupportedMediaType' }, { status: 415 });
  }

  // Content-Length is a client claim, so this is only a fast reject; the real
  // cap is enforced against the parsed bytes below.
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_NOTE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'notes.upload.errors.tooLarge' }, { status: 413 });
  }

  const form = await request.formData();
  const entry = form.get('file');
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: 'notes.upload.errors.missing' }, { status: 400 });
  }
  if (entry.size > MAX_NOTE_BYTES) {
    return NextResponse.json({ error: 'notes.upload.errors.tooLarge' }, { status: 413 });
  }

  const fields = createSchema.safeParse({
    title: form.get('title'),
    description: form.get('description'),
    subject: form.get('subject'),
    courseCode: form.get('courseCode') || undefined,
    academicYear: form.get('academicYear') || undefined,
    language: form.get('language') || 'az',
    priceMinor: form.get('priceMinor') ?? 0,
    universityId: form.get('universityId') || undefined,
  });
  if (!fields.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: fields.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await entry.arrayBuffer());

  // The decision is made from the bytes. `entry.type` is only cross-checked.
  const verdict = validateNoteFile(bytes, entry.type, entry.name);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: REJECTION_KEY[verdict.reason], reason: verdict.reason },
      { status: 400 },
    );
  }

  // Upload policy: PDF and Word only. Decided from the sniffed type, never
  // from the extension or the browser's claim.
  if (!NOTE_UPLOAD_MIME.includes(verdict.mime)) {
    return NextResponse.json(
      { error: 'notes.upload.errors.typeNotAllowed', reason: 'MIME_NOT_ALLOWED' },
      { status: 400 },
    );
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Same file, same seller, already uploaded. Cheap duplicate guard that also
  // stops a double-submitted form creating two identical listings.
  const duplicate = await findNoteBySellerAndHash(userId, sha256);
  if (duplicate) {
    return NextResponse.json(
      { error: 'notes.upload.errors.duplicate', noteId: duplicate.id },
      { status: 409 },
    );
  }

  const safeName = entry.name.replace(/[^\w.\-]+/g, '_').slice(-255);

  try {
    /**
     * The note and its file, then the audit entry.
     *
     * This was one Postgres transaction covering three tables. Firestore
     * cannot span a Storage write, so createNote() writes the object first and
     * the document second - the failure that leaves behind is an unreferenced
     * object, which is invisible and collectable, rather than a listing whose
     * download 404s for a buyer who paid.
     *
     * The audit entry follows rather than joining an atomic unit with them. An
     * audit row describing a note that does not exist would be worse than a
     * note whose upload was not logged, so it goes last and only on success.
     */
    const note = await createNote({
      id: newNoteId(),
      sellerId: userId,
      title: fields.data.title,
      description: fields.data.description,
      subject: fields.data.subject,
      courseCode: fields.data.courseCode,
      academicYear: fields.data.academicYear,
      language: fields.data.language,
      priceMinor: fields.data.priceMinor,
      universityId: fields.data.universityId,
      // Listed once a moderator approves it in the admin panel (Reviews).
      status: NoteStatus.PENDING_REVIEW,
      fileName: safeName,
      mime: verdict.mime,
      sha256,
      bytes,
    });

    await writeAuditLog({
      actorId: userId,
      action: 'NOTE_UPLOADED',
      entityType: 'note',
      entityId: note.id,
      after: { mime: verdict.mime, sizeBytes: bytes.length, sha256 },
      userAgent: request.headers.get('user-agent')?.slice(0, 512),
    });

    /**
     * Upload confirmation. One keyed read, and fire-and-forget - a mail
     * failure must not undo a stored note.
     */
    const seller = await findUserById(userId);
    if (seller) {
      sendEmailAsync(seller.email, 'noteUploaded', {
        nickname: seller.nickname,
        title: note.title,
      });
    }

    return NextResponse.json(
      {
        note: { id: note.id, title: note.title, status: note.status },
        file: { fileName: safeName, mime: verdict.mime, sizeBytes: bytes.length },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('[notes] upload failed', error);
    return NextResponse.json({ error: 'notes.upload.errors.storageFailed' }, { status: 502 });
  } finally {
    // The plaintext copy is not needed once it is committed. This is ordinary
    // user content rather than KYC material, so this is hygiene, not the
    // zero-retention rule.
    bytes.fill(0);
  }
}
