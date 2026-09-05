import { db } from '@/lib/db';
import { reapExpired } from '@/lib/verification/reviewBuffer';
import { runGraduationSweep } from './graduation';

/**
 * Long-running scheduler process.
 *
 * Two jobs with very different cadences live here rather than in separate
 * containers, because both are cheap and both need the same database client:
 *
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

const REAP_INTERVAL_MS = 15 * 60_000;
const GRAD_CHECK_INTERVAL_MS = 60 * 60_000;

let stopping = false;

/**
 * Reconciles Postgres with Redis after a review window lapses.
 *
 * Redis expires the encrypted blob on its own - that part does not depend on
 * this process running, which is the whole point of using a TTL rather than a
 * cleanup job. What this does is close the Postgres-side case so the user is
 * told to resubmit instead of waiting forever on a review that can no longer
 * happen.
 */
async function reapReviewBuffers(): Promise<void> {
  try {
    const reaped = await reapExpired(db as never);
    if (reaped > 0) {
      console.log('[scheduler] closed %d expired review case(s)', reaped);
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

  await reapReviewBuffers();
  await maybeRunGraduationSweep();

  const reapTimer = setInterval(() => void reapReviewBuffers(), REAP_INTERVAL_MS);
  const gradTimer = setInterval(() => void maybeRunGraduationSweep(), GRAD_CHECK_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log('[scheduler] %s received, draining', signal);
    clearInterval(reapTimer);
    clearInterval(gradTimer);
    await db.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[scheduler] fatal', error);
    process.exit(1);
  });
}
