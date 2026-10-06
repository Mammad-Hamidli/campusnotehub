import { after, NextResponse, type NextRequest } from 'next/server';
import { constantTimeEqual } from '@/lib/crypto/hash';
import { runAiVerificationBatch } from '@/lib/verification/aiQueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The Hobby ceiling with Fluid compute. The batch stops itself well before it.
export const maxDuration = 300;

/** How long one invocation spends on cases before handing over. */
const BUDGET_MS = 200_000;
/** Hand-overs per night: a runaway chain stops here whatever the queue says. */
const MAX_HOPS = 30;

/**
 * GET /api/cron/verification-ai
 *
 * The nightly AI identity check (src/lib/verification/aiQueue.ts). vercel.json
 * runs it at 20:00 UTC, which is 00:00 in Baku (UTC+4, no DST since 2016).
 * On the Hobby plan Vercel may fire it at any minute within that hour.
 * Authenticated with `Authorization: Bearer $CRON_SECRET`, like every cron.
 *
 * Answers 202 at once and runs the batch in after(), so the caller never waits
 * on a model. When the batch stops for TIME (not quota, not an outage) it
 * calls this route again, and that fresh invocation carries on from the head
 * of the queue - the queue itself is the cursor. Quota and outage stops do not
 * hand over: they wait for the next night, which is the point.
 *
 * The scheduler worker runs the same batch at Baku midnight without a time
 * limit, for deployments with a long-running process.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') ?? '';
  if (!secret || !constantTimeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 401 });
  }

  const hop = Math.max(0, Math.min(MAX_HOPS, Number(request.nextUrl.searchParams.get('hop') ?? 0) || 0));
  const next = new URL(request.nextUrl.pathname, request.nextUrl.origin);
  next.searchParams.set('hop', String(hop + 1));

  after(async () => {
    const result = await runAiVerificationBatch({ deadline: Date.now() + BUDGET_MS }).catch((error) => {
      console.error('[verification-ai] batch failed', error);
      return null;
    });
    if (result?.stoppedReason !== 'TIME_BUDGET' || hop + 1 >= MAX_HOPS) return;

    // The next invocation answers 202 straight away, so this only waits for
    // the hand-over itself, not for the work.
    await fetch(next, {
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    }).catch((error) => console.error('[verification-ai] hand-over to hop %d failed', hop + 1, error));
  });

  return NextResponse.json({ accepted: true, hop }, { status: 202 });
}
