import type { NextRequest } from 'next/server';
import { listOpenUserSessions, revokeOtherUserSessions } from '@/lib/firebase/repositories/sessions';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sessionIsLive } from '@/lib/auth/session';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { describeUserAgent } from '@/lib/security/userAgent';
import { groupSessionsByDevice } from '@/lib/security/sessionGroups';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me/sessions - the devices signed in to this account.
 *
 * Only sessions requireSession() would still accept (sessionIsLive), folded
 * into ONE row per device (see lib/security/sessionGroups.ts), newest activity
 * first. The device holding the session making this request is `current`.
 * `sessionCount` is how many live sessions the device holds; `id` is the one
 * to pass to DELETE /api/me/sessions/:id, which signs out the whole device.
 * `signedInAt` is the device's earliest sign-in still live (authAt survives
 * token rotation); `lastActiveAt` its latest authenticated request.
 */
export async function GET(request: NextRequest) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const now = new Date();
  const rows = (await listOpenUserSessions(session.userId)).filter((row) => sessionIsLive(row, now));

  const sessions = groupSessionsByDevice(rows).map(({ sessions: group }) => {
    const current = group.find((row) => row.id === session.sessionId);
    const newest = group[0];
    return {
      id: (current ?? newest).id,
      current: Boolean(current),
      sessionCount: group.length,
      device: describeUserAgent(newest.userAgent),
      signedInAt: new Date(Math.min(...group.map((row) => row.authAt.getTime()))).toISOString(),
      lastActiveAt: newest.lastSeenAt.toISOString(),
    };
  });

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
