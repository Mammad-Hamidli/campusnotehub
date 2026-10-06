// Must stay the first import: loads .env* the same way Next.js does.
import '../load-env';
import { runAiVerificationBatch } from '@/lib/verification/aiQueue';

/**
 * One AI verification batch, now: `npm run cron:verification-ai`.
 *
 * For a host crontab (`0 20 * * *` UTC = 00:00 Baku) or a manual run. Same
 * batch, lease and FIFO queue as the Vercel route and the scheduler worker,
 * with no time limit - it stops when the queue is empty or Workers AI stops it.
 */
if (require.main === module) {
  runAiVerificationBatch()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error('[verification-ai] fatal', error);
      process.exit(1);
    });
}
