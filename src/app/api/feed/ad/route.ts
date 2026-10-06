import { NextResponse } from 'next/server';
import { loadFeedAds } from '@/lib/feed/ad';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/feed/ad - every mentor promoted in the feed's ad slot (possibly
 * none). The client shows one of them per visit.
 *
 * Public and identical for every viewer, so the CDN serves it: a change made
 * in the admin panel shows within about half a minute, and the feed never
 * waits on Firestore for a sidebar card. A failed read is not cached - the
 * slot is just empty this once.
 */
export async function GET() {
  try {
    return NextResponse.json(
      { ads: await loadFeedAds() },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } },
    );
  } catch (error) {
    console.error('[feed-ad] load failed', error);
    return NextResponse.json({ ads: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
