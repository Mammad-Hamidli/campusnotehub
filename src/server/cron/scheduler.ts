// Must stay the first import: loads .env* the same way Next.js does.
import '../load-env';
import { LedgerTxnKind } from '@/lib/enums';
import { dueTasks, markExecuted, markFailed } from '@/lib/firebase/repositories/scheduledTasks';
import { releasePending } from '@/lib/wallet/ledger';
import { reapExpired, sweepExpiredAssets } from '@/lib/verification/reviewBuffer';
import { runGraduationSweep } from './graduation';
import { retryQueuedEmails } from '@/lib/email/send';

/**
 * Long-running scheduler process.
 *
 * Three jobs with very different cadences live here rather than in separate
 * containers, because all three are cheap and all three need the same Firebase
 * Admin app:
 *
 *   every  1 min  run due scheduled tasks (escrow releases, booking reminders)
 *   every 15 min  reap expired review buffers
 *   1 May 06:00   graduation sweep
 *
 * The graduation sweep is ALSO wired as a real cron entry on the host (see
 * package.json `cron:graduation`). Having both is deliberate: the host cron is
 * the primary trigger and survives this process crashing, while the in-process
 * check is the safety net for a host whose crontab was never installed. Both
 * paths are idempotent through `graduationPromptedAt`, so a double fire
 * prompts nobody twice.
 */

const TASK_INTERVAL_MS = 60_000;
const REAP_INTERVAL_MS = 15 * 60_000;
const GRAD_CHECK_INTERVAL_MS = 60 * 60_000;

let stopping = false;

/**
 * Runs work that was scheduled to happen later.
 *
 * ---------------------------------------------------------------------------
 * THIS LOOP IS NEW, AND IT IS NOT AN ADDITION - IT IS A REPAIR
 * ---------------------------------------------------------------------------
 * `scheduled_tasks` rows have always been written by the purchase and booking
 * paths, and nothing has ever read them. The consumer was going to be a BullMQ
 * worker at src/server/queue/notes.worker.ts, which package.json referenced but
 * which was never written - so every ESCROW_RELEASE ever queued has simply sat
 * there, and no seller's funds have ever cleared from PENDING to AVAILABLE.
 *
 * Removing Redis removed the last reason to keep waiting for that worker: the
 * queue was the only thing this needed a broker for, and Firestore holds the
 * schedule already. So the sweep lives here.
 *
 * ESCROW_RELEASE is the only kind handled. The two BOOKING_REMINDER_* kinds
 * are marked executed without acting, because push and email fan-out does not
 * exist yet (see the note in src/lib/notifications/dispatch.ts) - leaving them
 * due forever would grow an unbounded backlog of work nothing can do, and
 * pretending to send a reminder would be worse.
 */
async function runDueTasks(): Promise<void> {
  let tasks;
  try {
    tasks = await dueTasks(new Date());
  } catch (error) {
    console.error('[scheduler] could not read the task queue', error);
    return;
  }

  for (const task of tasks) {
    try {
      if (task.kind === 'ESCROW_RELEASE') {
        const payload = task.payload as
          | { orderId?: string; walletId?: string; amountMinor?: number }
          | null;

        if (!payload?.walletId || !payload.amountMinor || !payload.orderId) {
          // A payload we cannot act on is a permanent failure, not a transient
          // one. Recorded and left undone rather than retried forever.
          await markFailed(task.id, 'ESCROW_RELEASE payload is incomplete');
          continue;
        }

        /**
         * The reference key is derived from the ORDER, so releasePending() is
         * exactly-once by construction: a re-run posts to the same ledger
         * transaction id and is refused. That is what makes it safe for this
         * loop to retry a task whose `markExecuted` did not land.
         */
        await releasePending({
          referenceKey: `release:order:${payload.orderId}`,
          walletId: payload.walletId,
          amountMinor: payload.amountMinor,
          kind: LedgerTxnKind.NOTE_PAYOUT_RELEASE,
        });
      }

      await markExecuted(task.id);
    } catch (error) {
      /**
       * ALREADY_EXISTS means the posting is already in the ledger - the money
       * moved on an earlier run whose `markExecuted` did not land. The work is
       * done, so the task is closed rather than retried.
       */
      if ((error as { code?: number }).code === 6) {
        await markExecuted(task.id);
        continue;
      }

      // Anything else leaves `executedAt` null so the next sweep tries again,
      // and increments the attempt counter so a task that will never succeed
      // is visible to a human.
      const message = error instanceof Error ? error.message : String(error);
      console.error('[scheduler] task %s (%s) failed: %s', task.id, task.kind, message);
      await markFailed(task.id, message).catch(() => {});
    }
  }

  // Emails parked in the outbox after a failed delivery get their next try.
  await retryQueuedEmails().catch((error) => console.error('[scheduler] email retry failed', error));
}

/**
 * Closes verification cases whose review window has lapsed.
 *
 * ---------------------------------------------------------------------------
 * THIS SWEEP IS NOW LOAD-BEARING, WHERE IT USED TO BE A RECONCILIATION
 * ---------------------------------------------------------------------------
 * Redis expired the encrypted blob on its own, so this only had to close the
 * database side and tell the user to resubmit. Cloud Storage has no per-object
 * TTL, so reapExpired() is what actually DELETES the ciphertext.
 *
 * A dead scheduler therefore has a consequence it did not have before. It is
 * bounded, not unbounded: retrieve() refuses and destroys an expired buffer on
 * the read path, so lapsed documents stay unreadable regardless. See the header
 * of src/lib/verification/reviewBuffer.ts.
 */
async function reapReviewBuffers(): Promise<void> {
  try {
    const reaped = await reapExpired();
    if (reaped > 0) {
      console.log('[scheduler] closed %d expired review case(s)', reaped);
    }
    const swept = await sweepExpiredAssets();
    if (swept > 0) {
      console.log('[scheduler] deleted %d expired verification image(s) from Cloudinary', swept);
    }
  } catch (error) {
    console.error('[scheduler] reap failed', error);
  }
}

/** Fires the sweep only on 1 May, and only once per day. */
let lastGraduationRun: string | null = null;

async function maybeRunGraduationSweep(): Promise<void> {
  const now = new Date();
  // 06:00 Asia/Baku == 02:00 UTC. Azerbaijan has had no DST since 2016, so a
  // fixed offset is correct here; revisit if that ever changes.
  const bakuHour = (now.getUTCHours() + 4) % 24;
  const isMayFirst = now.getUTCMonth() === 4 && now.getUTCDate() === 1;
  const dayKey = now.toISOString().slice(0, 10);

  if (!isMayFirst || bakuHour < 6 || lastGraduationRun === dayKey) return;

  lastGraduationRun = dayKey;
  try {
    const result = await runGraduationSweep(now);
    console.log('[scheduler] graduation sweep %s', JSON.stringify(result));
  } catch (error) {
    console.error('[scheduler] graduation sweep failed', error);
    lastGraduationRun = null; // allow a retry on the next tick
  }
}

async function main(): Promise<void> {
  console.log('[scheduler] started');

  await runDueTasks();
  await reapReviewBuffers();
  await maybeRunGraduationSweep();

  const taskTimer = setInterval(() => void runDueTasks(), TASK_INTERVAL_MS);
  const reapTimer = setInterval(() => void reapReviewBuffers(), REAP_INTERVAL_MS);
  const gradTimer = setInterval(() => void maybeRunGraduationSweep(), GRAD_CHECK_INTERVAL_MS);

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log('[scheduler] %s received, draining', signal);
    clearInterval(taskTimer);
    clearInterval(reapTimer);
    clearInterval(gradTimer);
    /**
     * No explicit disconnect.
     *
     * This used to `await db.$disconnect()` to return pooled Postgres
     * connections. The Firestore client holds a gRPC channel that closes with
     * the process and needs no draining, and calling terminate() on the shared
     * Admin app would break any in-flight write that is still finishing.
     */
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[scheduler] fatal', error);
    process.exit(1);
  });
}
