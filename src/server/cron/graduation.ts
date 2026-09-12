// Must stay the first import: loads .env* the same way Next.js does.
import '../load-env';
import { UserRole } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { docsToObjects } from '@/lib/firebase/convert';
import { findUserById, updateUser } from '@/lib/firebase/repositories/users';
import { enqueueNotificationTx } from '@/lib/notifications/dispatch';

/**
 * The annual graduation sweep.
 *
 * Runs every 1 May at 06:00 Asia/Baku. Finds every verified user whose
 * graduation date has arrived or passed and who has not already moved to
 * alumni, then prompts them to transition.
 *
 * Scheduling (see docs/ARCHITECTURE.md for the deployment side):
 *
 *   0 6 1 5 *   cd /app && node dist/server/cron/graduation.js
 *
 * Timing note that is easy to get wrong: the cron host must run in UTC and the
 * expression above is UTC, so 06:00 Baku (UTC+4) is `0 2 1 5 *`. Azerbaijan
 * has had no DST since 2016, so the offset is a constant +4 and no timezone
 * library is needed here - but if that ever changes, this comment is the thing
 * to come back to.
 */

const BATCH_SIZE = 500;

export type SweepResult = {
  scanned: number;
  prompted: number;
  skipped: number;
  errors: number;
};

/**
 * Why 1 May specifically, and why "reached or passed" rather than "equals this
 * month": Azerbaijani universities run thesis defence and diploma issuance
 * through June, so prompting on 1 May reaches students while the date still
 * means something to them and leaves room to defer. The `<=` comparison also
 * sweeps up anyone whose date passed while the job was broken, which a strict
 * equality check would silently strand forever.
 */
export async function runGraduationSweep(now: Date = new Date()): Promise<SweepResult> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const result: SweepResult = { scanned: 0, prompted: 0, skipped: 0, errors: 0 };
  let cursor: string | undefined;

  for (;;) {
    // Keyset pagination, not OFFSET: this table grows, and the job must not
    // get quadratically slower each year.
    /**
     * Keyset pagination on the DOCUMENT ID, not an offset: this collection
     * grows, and the job must not get quadratically slower each year.
     *
     * `startAfter` on __name__ is the Firestore form of Prisma's `cursor` +
     * `skip: 1`, and it needs no index of its own because every collection is
     * ordered by document id by default.
     *
     * The equality filters go into the query. Two things do NOT:
     *
     *   - `graduationYear <= year`, because the "prompted at most once per
     *     calendar year" clause below is a second range on a different field
     *     and Firestore permits only one;
     *   - that clause itself, which was a cross-field `OR` (never prompted, OR
     *     prompted before January) and has no query form at all.
     *
     * Both are applied to the batch instead. The equality filters are what
     * keep that bounded - the scan is over active students, not the whole
     * user base.
     */
    let query: FirebaseFirestore.Query = adminDb()
      .collection(COLLECTIONS.users)
      .where('alumniTransitionedAt', '==', null)
      .where('deletedAt', '==', null)
      .where('accountStatus', '==', 'ACTIVE')
      .where('role', '==', UserRole.STUDENT)
      .orderBy('__name__')
      .limit(BATCH_SIZE);

    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    const startOfYear = new Date(Date.UTC(year, 0, 1));

    const batch = (
      docsToObjects<{
        id: string;
        graduationYear: number | null;
        graduationMonth: number | null;
        graduationPromptedAt: Date | null;
        locale: string;
      }>(snap.docs) as {
        id: string;
        graduationYear: number | null;
        graduationMonth: number | null;
        graduationPromptedAt: Date | null;
        locale: string;
      }[]
    ).filter(
      (u) =>
        u.graduationYear !== null &&
        u.graduationYear <= year &&
        // Prompted at most once per calendar year. Makes a re-run on the same
        // day a no-op, which matters because cron jobs get retried by hand.
        (!u.graduationPromptedAt || u.graduationPromptedAt < startOfYear),
    );

    /**
     * The cursor advances over the RAW page, not the filtered one.
     *
     * Taking it from `batch` would stall the sweep forever the first time a
     * whole page was filtered out: the last surviving id would be re-read on
     * every iteration, or - worse, when nothing survives - `batch` would be
     * empty and the loop would exit with users still unscanned behind it.
     */
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1].id;
    result.scanned += batch.length;

    for (const user of batch) {
      // A user graduating in December of the current year has not graduated
      // yet on 1 May. Prompt them next year.
      const gradYear = user.graduationYear!;
      const gradMonth = user.graduationMonth ?? 6;
      const reached = gradYear < year || (gradYear === year && gradMonth <= month);

      if (!reached) {
        result.skipped++;
        continue;
      }

      try {
        /**
         * A BATCH, so the notification and the stamp still commit together.
         *
         * That atomicity is the whole point here and it survives the move: a
         * crash between the two would either prompt the same person again next
         * run, or stamp someone who was never told. Neither write reads
         * anything, so a batch gives the guarantee without a transaction.
         */
        const writes = adminDb().batch();

        enqueueNotificationTx(writes, {
          userId: user.id,
          type: 'GRADUATION_TRANSITION_PROMPT',
          titleKey: 'notifications.types.GRADUATION_TRANSITION_PROMPT',
          bodyKey: 'verification.graduation.promptBody',
          params: { month: String(gradMonth).padStart(2, '0'), year: gradYear },
          linkUrl: '/dashboard?prompt=graduation',
        });

        writes.update(adminDb().collection(COLLECTIONS.users).doc(user.id), {
          graduationPromptedAt: new Date(),
          updatedAt: new Date(),
        });

        await writes.commit();
        result.prompted++;
      } catch (error) {
        // One bad row must not abort the sweep for everyone behind it.
        result.errors++;
        console.error('[graduation-sweep] user %s failed: %s', user.id, String(error));
      }
    }

    if (snap.docs.length < BATCH_SIZE) break;
  }

  return result;
}

/**
 * Applies the user's answer to the prompt.
 *
 * "Still studying" pushes the graduation year out by one rather than
 * cancelling. People extend, take academic leave, or switch programmes, and a
 * cancelled prompt means the account stays a "student" forever - which is
 * exactly the stale-status problem this feature exists to solve.
 */
export async function answerGraduationPrompt(params: {
  userId: string;
  answer: 'alumni' | 'still_studying' | 'later';
}): Promise<void> {
  const user = await findUserById(params.userId);
  if (!user) throw new Error(`no such user ${params.userId}`);

  if (params.answer === 'alumni') {
    await updateUser(params.userId, {
      role: UserRole.ALUMNI,
      alumniTransitionedAt: new Date(),
    });
    return;
  }

  if (params.answer === 'still_studying') {
    await updateUser(params.userId, {
      graduationYear: (user.graduationYear ?? new Date().getUTCFullYear()) + 1,
      graduationMonth: user.graduationMonth ?? 6,
      graduationPromptedAt: null, // eligible again next May
    });
    return;
  }

  // 'later' - leave graduationPromptedAt stamped so the annual job skips them
  // this year. The dashboard widget keeps showing the prompt.
}

/** CLI entry point for the cron host. */
if (require.main === module) {
  runGraduationSweep()
    .then((result) => {
      console.log('[graduation-sweep] %s', JSON.stringify(result));
      process.exit(result.errors > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('[graduation-sweep] fatal', error);
      process.exit(1);
    });
}
