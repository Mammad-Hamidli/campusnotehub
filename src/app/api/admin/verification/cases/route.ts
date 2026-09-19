import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus } from '@/lib/enums';
import { listCases } from '@/lib/firebase/repositories/verification';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
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

    const now = new Date();

    /**
     * Cleared rows are hidden by default and remain retrievable.
     *
     * This is a VIEW filter, not a deletion: the case, its verdict, its
     * moderator and its audit trail are all untouched, and asking for
     * includeDismissed=true brings it straight back. Keeping the two ideas
     * separate is the whole point of the field - a queue that gets tidy by
     * destroying evidence is not a queue anyone can audit.
     *
     * The free-text box matched the case id OR the applicant's name, nickname
     * or id - a search across a JOINED document, which Firestore cannot do at
     * all. It is resolved below, after the applicants are fetched, rather than
     * being silently dropped.
     *
     * `sort` is a z.enum, so it cannot become an arbitrary field name.
     */
    const { cases: allRows } = await listCases(
      { status: input.status, includeDismissed: input.includeDismissed },
      1,
      // Paged after the applicant search, so the whole matched set is needed
      // here rather than one page of it. Bounded by the repository's ceiling.
      Number.MAX_SAFE_INTEGER,
      input.sort,
      input.order,
    );

    const applicants = await findUsersByIds(allRows.map((c) => c.userId));

    const needle = input.q?.toLowerCase();
    const matched = needle
      ? allRows.filter((c) => {
          if (c.id === input.q || c.userId === input.q) return true;
          const applicant = applicants.get(c.userId);
          return Boolean(
            applicant?.fullName?.toLowerCase().includes(needle) ||
              applicant?.nickname?.toLowerCase().includes(needle),
          );
        })
      : allRows;

    const total = matched.length;
    const rows = matched.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);

    const universities = await findUniversitiesByIds(
      rows
        .map((c) => applicants.get(c.userId)?.universityId)
        .filter((id): id is string => Boolean(id)),
    );

    const moderators = await findUsersByIds(
      [...rows.map((c) => c.decidedByModeratorId), ...rows.map((c) => c.dismissedById)].filter(
        (id): id is string => Boolean(id),
      ),
    );

    return NextResponse.json(
      {
        cases: rows.map((c) => {
          const applicant = applicants.get(c.userId);
          const university = applicant?.universityId
            ? universities.get(applicant.universityId)
            : null;
          const reviewer = c.decidedByModeratorId
            ? moderators.get(c.decidedByModeratorId)
            : null;
          const dismisser = c.dismissedById ? moderators.get(c.dismissedById) : null;

          return {
          id: c.id,
          status: c.status,
          attempt: c.attempt,
          submittedAt: c.submittedAt,
          decidedAt: c.decidedAt,
          verdict: c.verdict,
          confidence: c.confidence ? Number(c.confidence) : null,
          failureCodes: c.failureCodes,
          moderatorNote: c.moderatorNote,
          user: applicant
            ? {
                id: applicant.id,
                fullName: applicant.fullName,
                nickname: applicant.nickname,
                verificationStatus: applicant.verificationStatus,
                /**
                 * The account type, so a reviewer knows which documents to
                 * expect before opening the case. A teacher submits two
                 * images, a student four - without this the queue looks like
                 * a teacher is missing paperwork.
                 */
                role: applicant.role,
                department: applicant.department,
                academicTitle: applicant.academicTitle,
                dateOfBirth: applicant.dateOfBirth,
                university: university
                  ? { code: university.code, nameEn: university.nameEn }
                  : null,
              }
            : null,
          reviewer: reviewer ? { id: reviewer.id, nickname: reviewer.nickname } : null,
          dismissedAt: c.dismissedAt,
          dismissedBy: dismisser ? { id: dismisser.id, nickname: dismisser.nickname } : null,
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
          };
        }),
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
