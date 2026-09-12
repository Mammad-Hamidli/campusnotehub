import { NextResponse, type NextRequest } from 'next/server';
import { constantTimeEqual } from '@/lib/crypto/hash';
import { retryQueuedEmails } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/email-outbox
 *
 * Retries emails that failed delivery and were parked in the `emailOutbox`
 * collection. The scheduler worker (npm run worker:scheduler) does the same
 * every minute; this is the equivalent for platforms that trigger jobs over
 * HTTP. Authenticated with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') ?? '';
  if (!secret || !constantTimeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 401 });
  }

  return NextResponse.json(await retryQueuedEmails(50));
}
