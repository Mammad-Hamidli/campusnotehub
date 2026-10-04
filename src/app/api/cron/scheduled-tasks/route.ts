import { NextResponse, type NextRequest } from 'next/server';
import { constantTimeEqual } from '@/lib/crypto/hash';
import { runDueTasks } from '@/lib/scheduled/run-due-tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/scheduled-tasks
 *
 * Runs due scheduled tasks - session-request expiry and Google Meet
 * provisioning retries - for platforms that trigger jobs over HTTP. The
 * scheduler worker (npm run worker:scheduler) does the same every minute.
 * Authenticated with `Authorization: Bearer $CRON_SECRET`.
 *
 * vercel.json runs it daily, which is all the Hobby plan allows. That is
 * enough for correctness - a lapsed request frees its slot at its deadline
 * without this, and the join route finishes a Meet room on demand - but the
 * mentee's "request expired" notice waits for the next run. On a plan with
 * finer crons (or with an external pinger), every 5-15 minutes is better.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') ?? '';
  if (!secret || !constantTimeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 401 });
  }
  return NextResponse.json(await runDueTasks(50));
}
