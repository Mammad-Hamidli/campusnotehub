import { NextResponse } from 'next/server';
import { loadFeedAdSlot } from '@/lib/feed/ad';
import { sweepExpiredFeedAds } from '@/lib/feed/ad-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The CDN window when no promotion ends soon. */
const S_MAXAGE = 30;
const STALE_WHILE_REVALIDATE = 60;

/**
 * GET /api/feed/ad - every mentor promoted in the feed's ad slot (possibly
 * none). The client shows one of them per visit.
 *
 * Public and identical for every viewer, so the CDN serves it: a change made
 * in the admin panel shows within about half a minute, and the feed never
 * waits on Firestore for a sidebar card. A failed read is not cached - the
 * slot is just empty this once.
 *
 * A promotion that has run out is already left out by loadFeedAdSlot. The
 * cache window is also cut short so the CDN cannot keep serving an ad past
 * its end: it never outlives the soonest expiry, and serves nothing stale
 * once one is near. The first read that finds a lapsed entry sweeps it, which
 * is what tells the mentor promptly even where crons run only daily.
 */
export async function GET() {
  try {
    const now = new Date();
    const slot = await loadFeedAdSlot(now);
    if (slot.lapsed) {
      await sweepExpiredFeedAds(now).catch((error) => console.error('[feed-ad] sweep failed', error));
    }

    const untilExpiry = slot.nextExpiry ? Math.ceil((slot.nextExpiry.getTime() - now.getTime()) / 1000) : Infinity;
    const cacheControl =
      untilExpiry > S_MAXAGE + STALE_WHILE_REVALIDATE
        ? `public, s-maxage=${S_MAXAGE}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`
        : `public, s-maxage=${Math.max(1, Math.min(S_MAXAGE, untilExpiry))}`;

    return NextResponse.json({ ads: slot.ads }, { headers: { 'Cache-Control': cacheControl } });
  } catch (error) {
    console.error('[feed-ad] load failed', error);
    return NextResponse.json({ ads: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
