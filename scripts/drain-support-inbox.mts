// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';
import { drainSupportInbox } from '@/lib/email/inbox';

/**
 * Reads the support@ mailbox once, from a shell.
 *
 *   npm run email:inbox
 *
 * Same work as GET /api/cron/support-inbox, without needing the deployment or
 * CRON_SECRET - for a first run after configuring IMAP, and for draining a
 * backlog by hand when the cron entry has been failing.
 */
const result = await drainSupportInbox(Number(process.argv[2] ?? 50));
console.log(`\n  fetched ${result.fetched}  stored ${result.stored}  duplicates ${result.skipped}\n`);
process.exit(0);
