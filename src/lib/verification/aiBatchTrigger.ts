import { after } from 'next/server';
import { runAiVerificationBatch } from './aiQueue';

/** The cron route; also the hand-over target for a run started any other way. */
export const AI_BATCH_CRON_PATH = '/api/cron/verification-ai';
/** How long one invocation spends on cases before handing over. */
const BUDGET_MS = 200_000;
/** Hand-overs per chain: a runaway chain stops here whatever the queue says. */
export const AI_BATCH_MAX_HOPS = 30;

/**
 * Starts one time-boxed AI verification batch AFTER the current response, so
 * the caller (Vercel Cron, or an admin pressing "Run now") never waits on a
 * model. Must be called inside a route handler; the route needs a
 * `maxDuration` above BUDGET_MS.
 *
 * When the batch stops for TIME (not quota, not an outage) it calls the cron
 * route with `?hop=n+1`, and that fresh invocation carries on from the head of
 * the queue - the queue itself is the cursor. Quota and outage stops do not
 * hand over: they wait for the next night. Without CRON_SECRET there is no
 * authenticated way to hand over, so the run simply ends at its budget.
 *
 * Overlap is impossible by construction: the batch takes a lease, and a second
 * start while one runs returns LEASE_HELD having touched nothing.
 */
export function scheduleAiBatch(origin: string, hop = 0): void {
  after(async () => {
    const result = await runAiVerificationBatch({ deadline: Date.now() + BUDGET_MS }).catch((error) => {
      console.error('[verification-ai] batch failed', error);
      return null;
    });
    const secret = process.env.CRON_SECRET;
    if (result?.stoppedReason !== 'TIME_BUDGET' || hop + 1 >= AI_BATCH_MAX_HOPS || !secret) return;

    const next = new URL(AI_BATCH_CRON_PATH, origin);
    next.searchParams.set('hop', String(hop + 1));
    // The next invocation answers 202 straight away, so this only waits for
    // the hand-over itself, not for the work.
    await fetch(next, {
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    }).catch((error) => console.error('[verification-ai] hand-over to hop %d failed', hop + 1, error));
  });
}
