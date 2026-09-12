import { NextResponse, type NextRequest } from 'next/server';
import { constantTimeEqual } from '@/lib/crypto/hash';
import { reapExpired, sweepExpiredAssets } from '@/lib/verification/reviewBuffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/verification-cleanup
 *
 * The 7-day deletion of registration verification images, for platforms that
 * trigger jobs over HTTP (Vercel Cron, Cloud Scheduler, a plain crontab curl).
 * The long-running worker in src/server/cron/scheduler.ts runs the same two
 * steps every 15 minutes; this is the equivalent for deployments without one.
 *
 * Authenticated with `Authorization: Bearer $CRON_SECRET` - the header Vercel
 * Cron sends. With CRON_SECRET unset the route refuses everything rather than
 * running unauthenticated.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') ?? '';
  if (!secret || !constantTimeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 401 });
  }

  const closedCases = await reapExpired();
  const deletedAssets = await sweepExpiredAssets();
  return NextResponse.json({ closedCases, deletedAssets });
}
