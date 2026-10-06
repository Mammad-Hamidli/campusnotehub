import { dueTasks, markExecuted, markFailed } from '@/lib/firebase/repositories/scheduledTasks';
import { expireRequest } from '@/lib/mentors/request-service';
import { provisionMeeting } from '@/lib/mentors/meeting';
import { sweepExpiredFeedAds } from '@/lib/feed/ad-admin';

/**
 * Runs work that was scheduled to happen later. Shared by the scheduler
 * worker (every minute) and GET /api/cron/scheduled-tasks (HTTP schedulers).
 *
 *   BOOKING_REQUEST_EXPIRE  closes an unanswered request and tells the mentee
 *   MEETING_PROVISION       (re)tries creating a session's Google Meet room
 *   BOOKING_REMINDER_*      closed without acting - reminder fan-out is not
 *                           built (see src/lib/notifications/dispatch.ts)
 *   ESCROW_RELEASE          legacy rows from the retired wallet; closed
 *
 * Both handlers are idempotent - they re-read the booking and do nothing
 * unless there is still something to do - so a task that runs late, twice,
 * or on two runners at once is harmless. Correctness never depends on this
 * running on time: an unanswered request stops holding its slot at its
 * deadline whether or not the task has run (src/lib/mentors/requests.ts).
 *
 * Also ends lapsed feed ads (sweepExpiredFeedAds). That needs no task rows:
 * the slot is one document, so checking it every run is a single read, and
 * nothing has to be unscheduled when staff renew or remove a promotion.
 */
export async function runDueTasks(take = 100): Promise<{ ran: number; failed: number; feedAdsExpired: number }> {
  // First and on its own: a broken task queue must not hold up the ad slot.
  const feedAdsExpired = await sweepExpiredFeedAds()
    .then((ids) => ids.length)
    .catch((error) => {
      console.error('[scheduler] feed ad sweep failed', error);
      return 0;
    });

  const tasks = await dueTasks(new Date(), take);
  let ran = 0;
  let failed = 0;

  for (const task of tasks) {
    const bookingId = typeof task.payload?.bookingId === 'string' ? task.payload.bookingId : null;
    try {
      if (task.kind === 'BOOKING_REQUEST_EXPIRE' && bookingId) {
        await expireRequest(bookingId);
      } else if (task.kind === 'MEETING_PROVISION' && bookingId) {
        const attempt = typeof task.payload?.attempt === 'number' ? task.payload.attempt : 1;
        await provisionMeeting(bookingId, attempt);
      }
      await markExecuted(task.id);
      ran += 1;
    } catch (error) {
      // `executedAt` stays null so the next sweep tries again; the attempt
      // counter makes a task that will never succeed visible to a human.
      const message = error instanceof Error ? error.message : String(error);
      console.error('[scheduler] task %s (%s) failed: %s', task.id, task.kind, message);
      await markFailed(task.id, message).catch(() => {});
      failed += 1;
    }
  }
  return { ran, failed, feedAdsExpired };
}
