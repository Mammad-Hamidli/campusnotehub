import { NextResponse, type NextRequest } from 'next/server';
import { constantTimeEqual } from '@/lib/crypto/hash';
import { drainSupportInbox } from '@/lib/email/inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/support-inbox
 *
 * Reads unseen mail from supportcampushub@gmail.com over IMAP into the
 * `supportInbox` collection. Wired to an hourly Vercel cron entry (see
 * vercel.json); `npm run email:inbox` does the same thing from a shell.
 * Authenticated with `Authorization: Bearer $CRON_SECRET`.
 *
 * A failure is returned as a 502 rather than swallowed: the whole purpose of
 * this endpoint is reading that mailbox, so a cron platform's own alerting on
 * a failing job is the right - and only - place for it to surface.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') ?? '';
  if (!secret || !constantTimeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 401 });
  }

  try {
    return NextResponse.json(await drainSupportInbox(50));
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'unknown error';
    console.error(`[inbox] drain failed: ${error}`);
    return NextResponse.json({ error }, { status: 502 });
  }
}
