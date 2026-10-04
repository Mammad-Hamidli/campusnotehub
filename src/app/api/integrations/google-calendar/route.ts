import { NextResponse, type NextRequest } from 'next/server';
import { browserOrigin } from '@/lib/app-url';
import { requireSession, UnauthorizedError, type SessionResult } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { providerConfig } from '@/lib/auth/oauth/providers';
import { beginAuthorization } from '@/lib/auth/oauth/flow';
import { setBindingCookie } from '@/lib/auth/oauth/http';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';
import { CALENDAR_SCOPE } from '@/lib/google/calendar';
import { disconnectCalendar } from '@/lib/google/disconnect';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function mentorSession(request: NextRequest): Promise<SessionResult | NextResponse> {
  let auth: SessionResult;
  try {
    auth = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }
  if (!can(auth.viewer, 'mentors:console')) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }
  return auth;
}

/**
 * POST /api/integrations/google-calendar -> { url }
 *
 * Starts the Google consent flow for calendar access. The browser navigates
 * to `url`; Google returns to the SAME registered callback as sign-in
 * (/api/auth/oauth/google/callback), which recognises the `calendar` intent
 * from the server-side state and stores the grant (handleCalendar in
 * src/lib/auth/oauth/callback.ts). Everything that hardens sign-in applies:
 * single-use server-side state, a browser binding cookie, PKCE, a nonce, and
 * the starting session re-checked on return.
 *
 * Scope: `calendar.events` only - events on calendars the mentor can edit,
 * not their calendar list, settings or other Google data - plus `openid
 * email` to show which account was connected.
 *
 * A POST, not a GET: it is started by a button for a signed-in mentor, and a
 * GET would let any page send a mentor's browser into the flow.
 */
export async function POST(request: NextRequest) {
  const auth = await mentorSession(request);
  if (auth instanceof NextResponse) return auth;

  const config = providerConfig('google');
  if (!config) return NextResponse.json({ error: 'mentors.calendar.errors.unavailable' }, { status: 503 });

  const limit = await rateLimit('auth:oauth:start', { ip: clientIp(request.headers) });
  if (!limit.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const { url, binding } = await beginAuthorization({
    config,
    intent: 'calendar',
    userId: auth.userId,
    sessionId: auth.sessionId,
    returnTo: MENTOR_DASHBOARD_PATH,
    userAgent: request.headers.get('user-agent') ?? '',
    requestOrigin: browserOrigin(request),
    scope: `openid email ${CALENDAR_SCOPE}`,
    offline: true,
  });
  const response = NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store' } });
  return setBindingCookie(response, binding);
}

/**
 * DELETE /api/integrations/google-calendar - forget the connection and revoke
 * the grant at Google. Sessions that already have a Meet room keep it (the
 * events stay on the mentor's calendar); new acceptances need a reconnect.
 */
export async function DELETE(request: NextRequest) {
  const auth = await mentorSession(request);
  if (auth instanceof NextResponse) return auth;

  const removed = await disconnectCalendar(auth.userId);
  if (removed) {
    await writeAuditLog({
      actorId: auth.userId,
      action: 'GOOGLE_CALENDAR_DISCONNECTED',
      entityType: 'user',
      entityId: auth.userId,
      userAgent: request.headers.get('user-agent')?.slice(0, 512),
      result: 'SUCCESS',
      after: {},
    });
  }
  return NextResponse.json({ ok: true, removed });
}
