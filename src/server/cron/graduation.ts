import { UserRole } from '@prisma/client';
import { db } from '@/lib/db';
import { enqueueNotification } from '@/lib/notifications/dispatch';

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
    const batch = await db.user.findMany({
      where: {
        alumniTransitionedAt: null,
        deletedAt: null,
        accountStatus: 'ACTIVE',
        graduationYear: { not: null, lte: year },
        role: { in: [UserRole.STUDENT] },
        // Prompted at most once per calendar year. Makes a re-run on the same
        // day a no-op, which matters because cron jobs get retried by hand.
        OR: [
          { graduationPromptedAt: null },
          { graduationPromptedAt: { lt: new Date(Date.UTC(year, 0, 1)) } },
        ],
      },
      select: {
        id: true,
        graduationYear: true,
        graduationMonth: true,
        locale: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
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
        await db.$transaction(async (tx) => {
          await enqueueNotification(tx, {
            userId: user.id,
            type: 'GRADUATION_TRANSITION_PROMPT',
            titleKey: 'notifications.types.GRADUATION_TRANSITION_PROMPT',
            bodyKey: 'verification.graduation.promptBody',
            params: { month: String(gradMonth).padStart(2, '0'), year: gradYear },
            linkUrl: '/dashboard?prompt=graduation',
          });

          // Stamped inside the same transaction as the notification, so a
          // crash between the two cannot produce a silent double-prompt.
          await tx.user.update({
            where: { id: user.id },
            data: { graduationPromptedAt: new Date() },
          });
        });
        result.prompted++;
      } catch (error) {
        // One bad row must not abort the sweep for everyone behind it.
        result.errors++;
        console.error('[graduation-sweep] user %s failed: %s', user.id, String(error));
      }
    }

    if (batch.length < BATCH_SIZE) break;
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
  const user = await db.user.findUniqueOrThrow({
    where: { id: params.userId },
    select: { graduationYear: true, graduationMonth: true },
  });

  if (params.answer === 'alumni') {
    await db.user.update({
      where: { id: params.userId },
      data: {
        role: UserRole.ALUMNI,
        alumniTransitionedAt: new Date(),
      },
    });
    return;
  }

  if (params.answer === 'still_studying') {
    await db.user.update({
      where: { id: params.userId },
      data: {
        graduationYear: (user.graduationYear ?? new Date().getUTCFullYear()) + 1,
        graduationMonth: user.graduationMonth ?? 6,
        graduationPromptedAt: null, // eligible again next May
      },
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
