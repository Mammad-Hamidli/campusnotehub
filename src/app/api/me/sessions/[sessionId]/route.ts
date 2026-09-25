import type { NextRequest } from 'next/server';
import { revokeOwnSession } from '@/lib/firebase/repositories/sessions';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/me/sessions/:sessionId - sign one device out.
 *
 * Only the account's own sessions, and not the one making the request: that
 * is what Sign out is for, and it also clears this browser's cookies. The
 * revocation takes effect on the device's next request, because every request
 * re-reads its session row (requireSession).
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const { sessionId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return mfaJson({ error: 'errors.validationFailed' }, 400);
  if (sessionId === session.sessionId) return mfaJson({ error: 'settings.devices.errors.current' }, 400);

  const limit = await rateLimit('sessions:revoke', { userId: session.userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return mfaJson({ error: 'errors.rateLimited' }, 429, { 'Retry-After': String(limit.retryAfterSeconds) });
  }

  // 404 for someone else's id as for a missing one: ids cannot be probed.
  if (!(await revokeOwnSession(session.userId, sessionId))) return mfaJson({ error: 'errors.notFound' }, 404);

  await writeAuditLog({
    actorId: session.userId,
    action: 'SESSION_REVOKED_BY_OWNER',
    entityType: 'session',
    entityId: sessionId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
  });
  return mfaJson({ ok: true });
}
