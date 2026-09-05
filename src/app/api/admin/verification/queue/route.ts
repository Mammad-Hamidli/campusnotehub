import { NextResponse, type NextRequest } from 'next/server';
import { UserRole, VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth/session';

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
  const { viewer } = await requireSession(request);
  if (viewer.role !== UserRole.MODERATOR && viewer.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }

  const cases = await db.verificationCase.findMany({
    where: {
      status: VerificationStatus.NEEDS_REVIEW,
      reviewBufferKey: { not: null },
      // Cases whose buffer already lapsed are not reviewable; the scheduler
      // closes them out. Showing them would only produce dead clicks.
      reviewExpiresAt: { gt: new Date() },
    },
    orderBy: [{ reviewPriority: 'desc' }, { submittedAt: 'asc' }],
    take: 50,
    select: {
      id: true,
      submittedAt: true,
      reviewExpiresAt: true,
      reviewPriority: true,
      confidence: true,
      failureCodes: true,
      verdict: true,
      attempt: true,
      user: {
        select: {
          id: true,
          fullName: true,
          createdAt: true,
          university: { select: { code: true } },
        },
      },
    },
  });

  return NextResponse.json(
    {
      cases: cases.map((c) => ({
        id: c.id,
        submittedAt: c.submittedAt,
        expiresAt: c.reviewExpiresAt,
        minutesLeft: c.reviewExpiresAt
          ? Math.max(0, Math.round((c.reviewExpiresAt.getTime() - Date.now()) / 60_000))
          : 0,
        priority: c.reviewPriority,
        confidence: c.confidence ? Number(c.confidence) : null,
        codes: c.failureCodes,
        verdict: c.verdict,
        attempt: c.attempt,
        applicant: {
          id: c.user.id,
          fullName: c.user.fullName,
          memberSince: c.user.createdAt,
          university: c.user.university?.code ?? null,
        },
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
