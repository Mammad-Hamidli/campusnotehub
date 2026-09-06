import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { NoteStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { can } from '@/lib/permissions';
import {
  MAX_NOTE_BYTES,
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

  const notes = await db.note.findMany({
    where: {
      status: NoteStatus.PUBLISHED,
      ...(universityId ? { universityId } : {}),
      ...(subject ? { subject } : {}),
    },
    orderBy:
      sort === 'trending'
        ? [{ purchaseCount: 'desc' }, { ratingAvg: 'desc' }, { publishedAt: 'desc' }]
        : [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true,
      title: true,
      subject: true,
      courseCode: true,
      language: true,
      priceMinor: true,
      currency: true,
      ratingAvg: true,
      ratingCount: true,
      purchaseCount: true,
      downloadCount: true,
      pageCount: true,
      publishedAt: true,
      createdAt: true,
      university: { select: { id: true, code: true, nameEn: true } },
      seller: { select: { id: true, nickname: true, isVerified: true } },
      // The bytes are NOT selected. Listing notes must never pull a 50 MB
      // column through the connection pool - the whole reason the file lives
      // in its own table.
      attachment: { select: { fileName: true, mime: true, sizeBytes: true } },
    },
  });

  return NextResponse.json(
    {
      notes: notes.map((n) => ({
        ...n,
        ratingAvg: Number(n.ratingAvg),
        priceMinor: n.priceMinor,
      })),
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

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Same file, same seller, already uploaded. Cheap duplicate guard that also
  // stops a double-submitted form creating two identical listings.
  const duplicate = await db.note.findFirst({
    where: { sellerId: userId, fileSha256: sha256 },
    select: { id: true },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: 'notes.upload.errors.duplicate', noteId: duplicate.id },
      { status: 409 },
    );
  }

  const safeName = entry.name.replace(/[^\w.\-]+/g, '_').slice(-255);

  try {
    const note = await db.$transaction(async (tx) => {
      const created = await tx.note.create({
        data: {
          sellerId: userId,
          title: fields.data.title,
          description: fields.data.description,
          subject: fields.data.subject,
          courseCode: fields.data.courseCode,
          academicYear: fields.data.academicYear,
          language: fields.data.language,
          priceMinor: fields.data.priceMinor,
          universityId: fields.data.universityId,
          // `fileKey` stays the logical locator the rest of the code talks in.
          // Today it addresses a row in note_attachments; if this moves to S3
          // it becomes an object key and nothing else has to change.
          fileKey: `db://note_attachments/${sha256}`,
          fileSha256: sha256,
          sizeBytes: bytes.length,
          status: NoteStatus.DRAFT,
        },
        select: { id: true, title: true, status: true },
      });

      await tx.noteAttachment.create({
        data: {
          noteId: created.id,
          fileName: safeName,
          mime: verdict.mime,
          sizeBytes: bytes.length,
          sha256,
          bytes,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: 'NOTE_UPLOADED',
          entityType: 'note',
          entityId: created.id,
          after: { mime: verdict.mime, sizeBytes: bytes.length, sha256 },
          userAgent: request.headers.get('user-agent')?.slice(0, 512),
        },
      });

      return created;
    });

    /**
     * Upload confirmation, after the transaction commits.
     *
     * The seller's address is read here rather than carried through the
     * transaction: it is one indexed lookup by primary key, and doing it
     * inside would hold the transaction open across a query it does not need.
     * Fire-and-forget - a mail failure must not undo a stored note.
     */
    const seller = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, nickname: true },
    });
    if (seller) {
      sendEmailAsync(seller.email, 'noteUploaded', {
        nickname: seller.nickname,
        title: note.title,
      });
    }

    return NextResponse.json(
      {
        note,
        file: { fileName: safeName, mime: verdict.mime, sizeBytes: bytes.length },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'notes.upload.errors.duplicate' }, { status: 409 });
    }
    throw error;
  } finally {
    // The plaintext copy is not needed once it is committed. This is ordinary
    // user content rather than KYC material, so this is hygiene, not the
    // zero-retention rule.
    bytes.fill(0);
  }
}
