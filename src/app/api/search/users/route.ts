import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { searchUsersByHandlePrefix } from '@/lib/firebase/repositories/users';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { isMessageable } from '@/lib/messages/serialize';
import { visibleAvatar } from '@/lib/profile/visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Shown at once - a dropdown, not a directory. */
const RESULTS = 8;
/** Read per query: hidden accounts are filtered after the read, so a few spare. */
const SCAN = 24;
/** A handle fragment: what a username may contain, lowercased, without the "@". */
const FRAGMENT = /^[a-z0-9_]{1,24}$/;

/**
 * GET /api/search/users?q=<handle prefix> - the dashboard's live user search.
 *
 * Matches the USERNAME only, from its start, case-insensitively: "ays" finds
 * @Aysel_01 and @ayshan, never a legal name, email or bio. A leading "@" is
 * ignored. Anything a handle cannot contain returns nothing rather than
 * widening the search, and so does an account that may not be shown
 * (suspended, deleted, or a quick-login account on its temporary handle).
 *
 * Signed-in only, and on the shared `search` bucket the profile lookup uses:
 * typing fires a request per pause, so the bucket is sized for that.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const raw = (request.nextUrl.searchParams.get('q') ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!FRAGMENT.test(raw)) {
    return NextResponse.json({ users: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const rate = await rateLimit('search', { userId: auth.userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const found = await searchUsersByHandlePrefix(raw, SCAN);
  const users = found
    .filter((user) => isMessageable(user, auth.userId))
    .slice(0, RESULTS)
    .map((user) => ({
      id: user.id,
      nickname: user.nickname,
      avatarUrl: visibleAvatar(user, auth.viewer),
      isVerified: user.isVerified,
      headline: user.headline,
    }));

  return NextResponse.json({ users }, { headers: { 'Cache-Control': 'no-store' } });
}
