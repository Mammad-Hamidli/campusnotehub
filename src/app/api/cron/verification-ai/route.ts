import { NextResponse, type NextRequest } from 'next/server';
import { constantTimeEqual } from '@/lib/crypto/hash';
import { AI_BATCH_MAX_HOPS, scheduleAiBatch } from '@/lib/verification/aiBatchTrigger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The Hobby ceiling with Fluid compute. The batch stops itself well before it.
export const maxDuration = 300;

/**
 * GET /api/cron/verification-ai
 *
 * The nightly AI identity check (src/lib/verification/aiQueue.ts). vercel.json
 * runs it at 20:00 UTC, which is 00:00 in Baku (UTC+4, no DST since 2016).
 * On the Hobby plan Vercel may fire it at any minute within that hour.
 * Authenticated with `Authorization: Bearer $CRON_SECRET`, like every cron.
 *
 * Answers 202 at once and runs a time-boxed batch in after(); a run that
 * stops for TIME hands over to this route again with `?hop=n+1` (see
 * scheduleAiBatch). Admins can start the same chain on demand from
 * /admin/verifications (POST /api/admin/verification/ai-batch); the nightly
 * schedule is unaffected by that.
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

  const hop = Math.max(0, Math.min(AI_BATCH_MAX_HOPS, Number(request.nextUrl.searchParams.get('hop') ?? 0) || 0));
  scheduleAiBatch(request.nextUrl.origin, hop);

  return NextResponse.json({ accepted: true, hop }, { status: 202 });
}
