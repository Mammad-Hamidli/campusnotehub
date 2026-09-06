import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus, VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { withAdmin } from '@/lib/auth/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/stats - the dashboard tiles.
 *
 * Every number is a COUNT against live tables. Nothing here is cached, derived
 * from a materialised summary, or seeded: a dashboard that can disagree with
 * the users table is worse than no dashboard, because it gets trusted anyway.
 *
 * All counts run in one $transaction so the tiles describe a single consistent
 * snapshot. Without it, "total" and the status breakdown are read microseconds
 * apart and a registration landing in between makes the parts fail to sum -
 * which reads as a bug in the panel every time.
 *
 * Soft-deleted accounts are excluded from every count except `deleted`. They
 * are rows in the table but they are not users of the platform, and padding
 * "total users" with them would misstate the only number anyone quotes.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const now = new Date();

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    // Rolling 7 days rather than "since Monday": the tile sits next to "today"
    // and a week that resets on Monday makes Monday's number look like an
    // outage. Labelled "last 7 days" in the UI so it is not read as calendar.
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

    const live = { deletedAt: null };

    const [
      total,
      verified,
      unverified,
      needsReview,
      processing,
      rejected,
      suspended,
      banned,
      restricted,
      deleted,
      newToday,
      newThisWeek,
      queueWaiting,
      queueExpiringSoon,
    ] = await db.$transaction([
      db.user.count({ where: live }),
      db.user.count({ where: { ...live, verificationStatus: VerificationStatus.VERIFIED } }),
      db.user.count({ where: { ...live, verificationStatus: VerificationStatus.UNVERIFIED } }),
      db.user.count({ where: { ...live, verificationStatus: VerificationStatus.NEEDS_REVIEW } }),
      db.user.count({ where: { ...live, verificationStatus: VerificationStatus.PROCESSING } }),
      db.user.count({ where: { ...live, verificationStatus: VerificationStatus.REJECTED } }),
      db.user.count({ where: { ...live, accountStatus: AccountStatus.SUSPENDED } }),
      db.user.count({ where: { ...live, accountStatus: AccountStatus.BANNED } }),
      db.user.count({ where: { ...live, accountStatus: AccountStatus.RESTRICTED } }),
      db.user.count({ where: { deletedAt: { not: null } } }),
      db.user.count({ where: { ...live, createdAt: { gte: startOfToday } } }),
      db.user.count({ where: { ...live, createdAt: { gte: sevenDaysAgo } } }),
      // Reviewable means NEEDS_REVIEW *and* the buffer is still alive - the
      // same predicate the moderator queue uses. Counting cases whose
      // documents already evaporated would promise work that cannot be done.
      db.verificationCase.count({
        where: {
          status: VerificationStatus.NEEDS_REVIEW,
          reviewBufferKey: { not: null },
          reviewExpiresAt: { gt: now },
        },
      }),
      db.verificationCase.count({
        where: {
          status: VerificationStatus.NEEDS_REVIEW,
          reviewBufferKey: { not: null },
          reviewExpiresAt: { gt: now, lt: new Date(now.getTime() + 4 * 3_600_000) },
        },
      }),
    ]);

    return NextResponse.json(
      {
        users: {
          total,
          verified,
          unverified,
          needsReview,
          processing,
          rejected,
          suspended,
          banned,
          restricted,
          deleted,
          newToday,
          newThisWeek,
        },
        verification: { queueWaiting, queueExpiringSoon },
        generatedAt: now.toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
