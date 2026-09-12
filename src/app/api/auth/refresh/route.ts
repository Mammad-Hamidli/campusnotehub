import { NextResponse, type NextRequest } from 'next/server';
import { rotateSession, UnauthorizedError } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Session refresh.
 *
 * The access token (CH_AT) lives 15 minutes for students and its cookie
 * expires with it. The refresh token (CH_RT) lives 30 days but is scoped to
 * `path=/api/auth`, so it only ever reaches THIS route. Without this route
 * rotateSession() had no caller and every student was bounced to /login a
 * quarter of an hour after signing in.
 *
 * GET  - navigation. The middleware redirects a protected page request with no
 *        valid access token here; on success the browser is sent back to
 *        `next` with fresh cookies, otherwise to /login?next=...
 * POST - background. SessionKeeper calls it once when an API request returns
 *        401, then replays the request.
 *
 * Cookies are deliberately NOT cleared on failure: a failure can be the loser
 * of a concurrent refresh whose winner has just written fresh cookies to the
 * same jar. /logout remains the one place that clears them.
 */

/** Same-origin paths only: `//host` and `/\host` would be open redirects. */
function safeNext(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) ? value : '/dashboard';
}

async function refresh(request: NextRequest) {
  const token = request.cookies.get('CH_RT')?.value;
  if (!token) return null;
  try {
    return await rotateSession(token, request.headers.get('user-agent') ?? '');
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/**
 * Short-lived marker the middleware reads to avoid a redirect loop if a freshly
 * issued token somehow still fails verification at the edge.
 */
function markRefreshed(response: NextResponse) {
  response.cookies.set('CH_RF', '1', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 15,
  });
  return response;
}

export async function POST(request: NextRequest) {
  const session = await refresh(request);
  if (!session) {
    return NextResponse.json(
      { error: 'errors.sessionExpired' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  return markRefreshed(session.applyCookies(response));
}

export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  const session = await refresh(request);

  if (!session) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', next);
    const response = NextResponse.redirect(login);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const response = NextResponse.redirect(new URL(next, request.url));
  response.headers.set('Cache-Control', 'no-store');
  return markRefreshed(session.applyCookies(response));
}
