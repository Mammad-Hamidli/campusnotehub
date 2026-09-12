import { NextResponse, type NextRequest } from 'next/server';
import { reviewQueue } from '@/lib/firebase/repositories/verification';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { withAdmin } from '@/lib/auth/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/verification/queue
 *
 * The moderator work list. Ordered by priority first, then oldest-first, so
 * suspected tampering and last-attempt users surface ahead of routine
 * ambiguity while nothing starves at the bottom.
 *
 * Note what this endpoint does NOT return: no images, no names extracted from
 * documents, no decryption secrets. It returns enough to triage - scores,
 * signal codes, how long is left on the buffer - and the moderator has to open
 * an individual case (which writes an audit row) to see anything sensitive.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const now = new Date();

    /**
     * Priority first, then oldest-first. reviewQueue() applies that ordering
     * in memory - it is `status, reviewPriority DESC, submittedAt ASC`, a
     * three-field sort that Firestore would need a dedicated composite index
     * for and that no other query shares.
     */
    const queue = await reviewQueue(50);

    /**
     * Cases whose buffer already lapsed are not reviewable; the scheduler
     * closes them out. Showing them would only produce dead clicks.
     *
     * Filtered here rather than in the query because `reviewBufferKey != null`
     * and `reviewExpiresAt > now` are two inequalities on different fields,
     * and Firestore permits a range on only one - so pushing either into the
     * query would still leave the other to be applied afterwards.
     */
    const cases = queue.filter(
      (c) => Boolean(c.reviewBufferKey) && c.reviewExpiresAt !== null && c.reviewExpiresAt > now,
    );

    // The applicant decoration Prisma did with a join, as two batched reads.
    const applicants = await findUsersByIds(cases.map((c) => c.userId));
    const universities = await findUniversitiesByIds(
      [...applicants.values()]
        .map((u) => u.universityId)
        .filter((id): id is string => Boolean(id)),
    );

    return NextResponse.json(
      {
        cases: cases.map((c) => {
          const applicant = applicants.get(c.userId);
          const university = applicant?.universityId
            ? universities.get(applicant.universityId)
            : null;
          return {
            id: c.id,
            submittedAt: c.submittedAt,
            expiresAt: c.reviewExpiresAt,
            minutesLeft: c.reviewExpiresAt
              ? Math.max(0, Math.round((c.reviewExpiresAt.getTime() - now.getTime()) / 60_000))
              : 0,
            priority: c.reviewPriority,
            confidence: c.confidence ? Number(c.confidence) : null,
            codes: c.failureCodes,
            verdict: c.verdict,
            attempt: c.attempt,
            applicant: applicant
              ? {
                  id: applicant.id,
                  fullName: applicant.fullName,
                  memberSince: applicant.createdAt,
                  university: university?.code ?? null,
                }
              : null,
          };
        }),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
