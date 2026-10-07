import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { searchUsersByHandlePrefix, type UserRecord } from '@/lib/firebase/repositories/users';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { isMessageable } from '@/lib/messages/serialize';
import { visibleAvatar } from '@/lib/profile/visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The dropdown's page: ten rows, then "View all results". */
const DEFAULT_LIMIT = 10;
/** The results page asks for more per request, never more than this. */
const MAX_LIMIT = 30;
/** Read per round: hidden accounts are filtered after the read, so a few spare. */
const SCAN = 40;
/** Rounds per request: bounds the reads a run of hidden accounts can cost. */
const MAX_ROUNDS = 3;
/** A handle fragment: what a username may contain, lowercased, without the "@". */
const FRAGMENT = /^[a-z0-9_]{1,24}$/;
/** A cursor is a whole handle, so it may be longer than a typed fragment. */
const CURSOR = /^[a-z0-9_]{1,40}$/;

/**
 * One page of visible matches after `after`.
 *
 * `next` is the last handle this page CONSUMED (shown or skipped as hidden),
 * so the following page neither repeats nor loses a row. It is null only when
 * the index has nothing further; a page cut short by MAX_ROUNDS still carries
 * a cursor, and the next request simply goes on from there.
 */
async function page(prefix: string, limit: number, after: string | undefined, viewerId: string) {
  const hits: UserRecord[] = [];
  let cursor = after;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const batch = await searchUsersByHandlePrefix(prefix, SCAN, cursor);
    for (const user of batch) {
      if (isMessageable(user, viewerId)) {
        // A visible match beyond the page: there is more, and it starts here.
        if (hits.length === limit) return { hits, next: cursor ?? null };
        hits.push(user);
      }
      cursor = user.nicknameLower;
    }
    if (batch.length < SCAN) return { hits, next: null };
  }
  return { hits, next: cursor ?? null };
}

/**
 * GET /api/search/users?q=<handle prefix>[&limit=<n>][&after=<cursor>]
 *
 * The dashboard's live user search and the /search results page behind it.
 *
 * Matches the USERNAME only, from its start, case-insensitively: "ays" finds
 * @Aysel_01 and @ayshan, never a legal name, email or bio. A leading "@" is
 * ignored. Anything a handle cannot contain returns nothing rather than
 * widening the search, and so does an account that may not be shown
 * (suspended, deleted, or a quick-login account on its temporary handle).
 *
 * Keyset-paginated on the handle: `nextCursor` is non-null while more matches
 * may follow, and is passed back as `after`.
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

  const params = request.nextUrl.searchParams;
  const raw = (params.get('q') ?? '').trim().replace(/^@/, '').toLowerCase();
  const after = params.get('after') ?? undefined;
  // A cursor must lie inside this prefix's range; anything else is not a continuation.
  if (!FRAGMENT.test(raw) || (after !== undefined && (!CURSOR.test(after) || !after.startsWith(raw)))) {
    return NextResponse.json({ users: [], nextCursor: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const requested = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, requested)) : DEFAULT_LIMIT;

  const rate = await rateLimit('search', { userId: auth.userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const { hits, next } = await page(raw, limit, after, auth.userId);
  const users = hits.map((user) => ({
    id: user.id,
    nickname: user.nickname,
    avatarUrl: visibleAvatar(user, auth.viewer),
    isVerified: user.isVerified,
    headline: user.headline,
  }));

  return NextResponse.json({ users, nextCursor: next }, { headers: { 'Cache-Control': 'no-store' } });
}
