// Must stay the first import: loads .env* the same way Next.js does.
import '../load-env';
import { dueTasks, markExecuted, markFailed } from '@/lib/firebase/repositories/scheduledTasks';
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
 *   every  1 min  run due scheduled tasks (booking reminders), retry queued email
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
 * The two BOOKING_REMINDER_* kinds are marked executed without acting,
 * because push and email fan-out does not exist yet (see the note in
 * src/lib/notifications/dispatch.ts) - leaving them due forever would grow an
 * unbounded backlog of work nothing can do. Legacy ESCROW_RELEASE rows from
 * the retired wallet are closed the same way: there is no money to move.
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
      await markExecuted(task.id);
    } catch (error) {
      // A failure leaves `executedAt` null so the next sweep tries again,
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
