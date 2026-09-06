import { NextResponse, type NextRequest } from 'next/server';
import { type Prisma, VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { withAdmin } from '@/lib/auth/admin';
import { adminVerificationListSchema } from '@/server/validators/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/verification/cases - the full case history.
 *
 * This is a SIBLING of /api/admin/verification/queue, not a replacement, and
 * the existing endpoint is untouched. They answer different questions:
 *
 *   queue  - "what can I action right now": NEEDS_REVIEW only, live buffer
 *            only, priority-ordered, no paging. It is the moderator work list
 *            and ModerationConsole depends on its exact shape.
 *   cases  - "what has happened": every status including decided and expired
 *            ones, filterable and paged, for the audit-style view.
 *
 * Merging them would have meant changing the queue's contract to serve a
 * reporting screen, and a work list that can accidentally show unactionable
 * rows is worse than two endpoints.
 *
 * No decryption secret and no buffer key is returned. Opening a case for review
 * still goes through /api/admin/verification/:caseId, which is the only path
 * that touches documents and the only one that writes a KYC_DOCUMENTS_VIEWED
 * audit row.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const parsed = adminVerificationListSchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const where: Prisma.VerificationCaseWhereInput = {};
    if (input.status) where.status = input.status;
    /**
     * Cleared rows are hidden by default and remain retrievable.
     *
     * This is a VIEW filter, not a deletion: the row, its verdict, its
     * moderator and its audit trail are all untouched, and asking for
     * includeDismissed=true brings it straight back. Keeping the two ideas
     * separate is the whole point of the column - a queue that gets tidy by
     * destroying evidence is not a queue anyone can audit.
     */
    if (!input.includeDismissed) where.dismissedAt = null;
    if (input.q) {
      where.OR = [
        { id: input.q },
        { user: { fullName: { contains: input.q, mode: 'insensitive' } } },
        { user: { nickname: { contains: input.q, mode: 'insensitive' } } },
        { user: { id: input.q } },
      ];
    }

    const orderBy: Prisma.VerificationCaseOrderByWithRelationInput[] = [
      { [input.sort]: input.order } as Prisma.VerificationCaseOrderByWithRelationInput,
      { id: 'asc' },
    ];

    const now = new Date();

    const [total, rows] = await db.$transaction([
      db.verificationCase.count({ where }),
      db.verificationCase.findMany({
        where,
        orderBy,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        select: {
          id: true,
          status: true,
          attempt: true,
          submittedAt: true,
          decidedAt: true,
          verdict: true,
          confidence: true,
          failureCodes: true,
          // reviewPriority is no longer SELECTED: the Priority column was
          // removed from the table because an operator cannot act on it - the
          // queue is already ordered by it, so the number restated a fact the
          // row order was showing and took a column's width to do it. It is
          // still a permitted `sort` value, which needs no select.
          reviewExpiresAt: true,
          reviewBufferKey: true,
          moderatorNote: true,
          dismissedAt: true,
          dismissedBy: { select: { id: true, nickname: true } },
          user: {
            select: {
              id: true,
              fullName: true,
              nickname: true,
              verificationStatus: true,
              university: { select: { code: true, nameEn: true } },
            },
          },
          decidedByModerator: { select: { id: true, nickname: true } },
        },
      }),
    ]);

    return NextResponse.json(
      {
        cases: rows.map((c) => ({
          id: c.id,
          status: c.status,
          attempt: c.attempt,
          submittedAt: c.submittedAt,
          decidedAt: c.decidedAt,
          verdict: c.verdict,
          confidence: c.confidence ? Number(c.confidence) : null,
          failureCodes: c.failureCodes,
          moderatorNote: c.moderatorNote,
          user: c.user,
          reviewer: c.decidedByModerator,
          dismissedAt: c.dismissedAt,
          dismissedBy: c.dismissedBy,
          /**
           * The key itself never leaves the server - only whether documents are
           * still there to look at. That is what the UI needs to decide between
           * an enabled "Review" button and an "expired" badge, and it is the
           * difference between a useful column and handing out a decryption pointer.
           */
          reviewable:
            c.status === VerificationStatus.NEEDS_REVIEW &&
            c.reviewBufferKey !== null &&
            c.reviewExpiresAt !== null &&
            c.reviewExpiresAt > now,
          minutesLeft: c.reviewExpiresAt
            ? Math.max(0, Math.round((c.reviewExpiresAt.getTime() - now.getTime()) / 60_000))
            : null,
        })),
        page: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
