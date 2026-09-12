import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus, VerificationStatus } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
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
 * ---------------------------------------------------------------------------
 * THESE COUNTS ARE NO LONGER A SINGLE SNAPSHOT - AND THAT IS VISIBLE
 * ---------------------------------------------------------------------------
 * They used to run in one `$transaction` so "total" and the status breakdown
 * could not be read microseconds apart, because a registration landing in
 * between makes the parts fail to sum and reads as a bug in the panel every
 * time.
 *
 * Firestore's count() aggregation cannot participate in a transaction, and
 * reading every document to count it in one would be a full collection scan
 * per tile. So the counts are issued CONCURRENTLY and are individually exact
 * but mutually microseconds apart.
 *
 * Rather than let an operator discover that by arithmetic, the response says
 * so: `consistent: false` and the note below the tiles. A dashboard that
 * quietly does not add up gets trusted anyway, which is the failure the
 * transaction was there to prevent - being explicit is the honest substitute
 * for a guarantee that is no longer available.
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

    const users = adminDb().collection(COLLECTIONS.users);
    const cases = adminDb().collection(COLLECTIONS.verificationCases);

    /**
     * `deletedAt == null` is an EQUALITY here, not `IS NULL`.
     *
     * That works only because every user document is written with an explicit
     * `deletedAt: null` - see newUserDefaults() - rather than omitting the
     * field. Firestore cannot match a document on a field it does not have, so
     * a user created without that key would be invisible to every count below.
     * This is exactly why ./convert.forFirestore() preserves null and strips
     * only undefined.
     */
    const live = (query: FirebaseFirestore.Query) => query.where('deletedAt', '==', null);
    /**
     * One failing tile must not take the whole dashboard down, which is what
     * happened: a null renders as "-" and the error is logged.
     */
    const count = async (query: FirebaseFirestore.Query): Promise<number | null> => {
      try {
        return (await query.count().get()).data().count;
      } catch (error) {
        console.error('[admin/stats] count failed', error);
        return null;
      }
    };

    /**
     * New sign-ups since a date.
     *
     * `deletedAt == null` combined with a `createdAt` range needs a composite
     * index this project never had; the FAILED_PRECONDITION it threw was the
     * broken "Idare paneli". A single-field range needs no composite index,
     * and deleted accounts are excluded in memory from a one-field projection.
     */
    const createdSince = async (since: Date): Promise<number | null> => {
      try {
        const snap = await users.where('createdAt', '>=', since).select('deletedAt').get();
        return snap.docs.filter((doc) => doc.get('deletedAt') == null).length;
      } catch (error) {
        console.error('[admin/stats] createdSince failed', error);
        return null;
      }
    };

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
      reviewable,
      expiringSoon,
    ] = await Promise.all([
      count(live(users)),
      count(live(users).where('verificationStatus', '==', VerificationStatus.VERIFIED)),
      count(live(users).where('verificationStatus', '==', VerificationStatus.UNVERIFIED)),
      count(live(users).where('verificationStatus', '==', VerificationStatus.NEEDS_REVIEW)),
      count(live(users).where('verificationStatus', '==', VerificationStatus.PROCESSING)),
      count(live(users).where('verificationStatus', '==', VerificationStatus.REJECTED)),
      count(live(users).where('accountStatus', '==', AccountStatus.SUSPENDED)),
      count(live(users).where('accountStatus', '==', AccountStatus.BANNED)),
      count(live(users).where('accountStatus', '==', AccountStatus.RESTRICTED)),
      // The one count that is NOT scoped to live accounts - it is the tile
      // that reports them.
      count(users.where('deletedAt', '!=', null)),
      createdSince(startOfToday),
      createdSince(sevenDaysAgo),
      /**
       * Reviewable means NEEDS_REVIEW *and* the buffer is still alive - the
       * same predicate the moderator queue uses. Counting cases whose
       * documents already evaporated would promise work that cannot be done.
       *
       * Firestore allows a range filter on only ONE field, so the range goes
       * on `reviewExpiresAt` (the one that actually narrows) and the
       * `reviewBufferKey != null` half is applied below. That is why these two
       * are counted from documents rather than by an aggregation.
       */
      cases
        .where('status', '==', VerificationStatus.NEEDS_REVIEW)
        .where('reviewExpiresAt', '>', now)
        .limit(2000)
        .get(),
      cases
        .where('status', '==', VerificationStatus.NEEDS_REVIEW)
        .where('reviewExpiresAt', '>', now)
        .where('reviewExpiresAt', '<', new Date(now.getTime() + 4 * 3_600_000))
        .limit(2000)
        .get(),
    ]);

    const hasBuffer = (snap: FirebaseFirestore.QuerySnapshot) =>
      snap.docs.filter((doc) => Boolean(doc.data().reviewBufferKey)).length;

    const queueWaiting = hasBuffer(reviewable);
    const queueExpiringSoon = hasBuffer(expiringSoon);

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
        /**
         * Says out loud that the tiles are not one snapshot. See the header:
         * each number is exact, but they are read microseconds apart, so the
         * breakdown can be one registration away from summing to `total`.
         */
        consistent: false,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
