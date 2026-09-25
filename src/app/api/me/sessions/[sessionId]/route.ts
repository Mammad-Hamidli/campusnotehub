import type { NextRequest } from 'next/server';
import { findSessionById, listOpenUserSessions, revokeOwnSessions } from '@/lib/firebase/repositories/sessions';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sessionIsLive } from '@/lib/auth/session';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { groupSessionsByDevice } from '@/lib/security/sessionGroups';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/me/sessions/:sessionId - sign one DEVICE out.
 *
 * The Devices list shows one row per device (lib/security/sessionGroups.ts),
 * so the id names a device: every live session grouped with it is revoked,
 * in one call, grouped exactly as GET /api/me/sessions grouped them. The id
 * may already be rotated away (every refresh replaces the row); its stored
 * deviceId / User-Agent still identify the device, so a list that went stale
 * a minute ago still signs out the right machine.
 *
 * Never the session making the request: that is what Sign out is for, and it
 * also clears this browser's cookies. On this device's own row it signs out
 * the OTHER sessions this device holds, and refuses when there are none. The
 * revocation takes effect on each session's next request, because every
 * request re-reads its session row (requireSession).
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const { sessionId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const limit = await rateLimit('sessions:revoke', { userId: session.userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  // 404 for someone else's id as for a missing one: ids cannot be probed.
  const target = await findSessionById(sessionId);
  if (!target || target.userId !== session.userId) return mfaJson({ error: 'errors.notFound' }, 404);

  const now = new Date();
  const live = (await listOpenUserSessions(session.userId)).filter((row) => sessionIsLive(row, now));
  const rows = live.some((row) => row.id === target.id) ? live : [...live, target];
  const device = groupSessionsByDevice(rows).find((group) => group.sessions.some((row) => row.id === target.id));
  const doomed = (device?.sessions ?? [])
    .filter((row) => row.id !== session.sessionId && !row.revokedAt)
    .map((row) => row.id);

  if (doomed.length === 0) {
    const isThisDevice = device?.sessions.some((row) => row.id === session.sessionId) ?? false;
    return isThisDevice
      ? mfaJson({ error: 'settings.devices.errors.current' }, 400)
      : mfaJson({ error: 'errors.notFound' }, 404);
  }

  const revoked = await revokeOwnSessions(session.userId, doomed);

  await writeAuditLog({
    actorId: session.userId,
    action: 'SESSION_REVOKED_BY_OWNER',
    entityType: 'session',
    entityId: sessionId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { revoked },
  });
  return mfaJson({ ok: true, revoked });
}
