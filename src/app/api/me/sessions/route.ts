import type { NextRequest } from 'next/server';
import { listOpenUserSessions, revokeOtherUserSessions } from '@/lib/firebase/repositories/sessions';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sessionIsLive } from '@/lib/auth/session';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { describeUserAgent } from '@/lib/security/userAgent';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me/sessions - the devices signed in to this account.
 *
 * Only sessions requireSession() would still accept (sessionIsLive), newest
 * activity first, with the one making this request marked `current`.
 * `signedInAt` is the original sign-in (authAt survives token rotation);
 * `lastActiveAt` is the last authenticated request.
 */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const now = new Date();
  const rows = (await listOpenUserSessions(session.userId)).filter((row) => sessionIsLive(row, now));

  const sessions = rows
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .map((row) => ({
      id: row.id,
      current: row.id === session.sessionId,
      device: describeUserAgent(row.userAgent),
      signedInAt: row.authAt.toISOString(),
      lastActiveAt: row.lastSeenAt.toISOString(),
    }));

  return mfaJson({ sessions });
}

/** DELETE /api/me/sessions - sign out every OTHER device. */
export async function DELETE(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const limit = await rateLimit('sessions:revoke', { userId: session.userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  const revoked = await revokeOtherUserSessions(session.userId, session.sessionId);
  await writeAuditLog({
    actorId: session.userId,
    action: 'SESSIONS_REVOKED_BY_OWNER',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { revoked },
  });
  return mfaJson({ ok: true, revoked });
}
