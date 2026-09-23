import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { unlinkIdentity } from '@/lib/firebase/repositories/identities';
import { revokeOtherUserSessions } from '@/lib/firebase/repositories/sessions';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sendEmailAsync } from '@/lib/email/send';
import { PROVIDER_LABELS, isProviderId } from '@/lib/auth/oauth/providers';
import { reauthenticate } from '@/lib/auth/reauth';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    password: z.string().min(1).max(200).optional(),
    code: z.string().trim().max(16).optional(),
    recoveryCode: z.string().trim().max(32).optional(),
  })
  .strict();

/**
 * DELETE /api/me/identities/[provider] - disconnect a provider.
 *
 * Re-authentication first (a stolen session must not be able to cut the
 * owner off from their own sign-in method), then the last-method check in
 * unlinkIdentity(), which refuses to leave an account with no way in.
 *
 * Other sessions are revoked: any of them may have been opened through the
 * provider being removed, and removing it is exactly when that should end.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isProviderId(provider)) return mfaJson({ error: 'errors.notFound' }, 404);

  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return mfaJson({ error: 'errors.validationFailed' }, 400);

  const proof = await reauthenticate(request, session, parsed.data);
  if (proof instanceof Response) return proof;

  const result = await unlinkIdentity(session.userId, provider);
  if (result === 'not_linked') return mfaJson({ error: 'errors.notFound' }, 404);
  if (result === 'last_method') return mfaJson({ error: 'auth.oauth.errors.last_method' }, 409);

  const revoked = await revokeOtherUserSessions(session.userId, session.sessionId);
  const user = await findUserById(session.userId);
  if (user) sendEmailAsync(user.email, 'oauthUnlinked', { nickname: user.nickname, provider: PROVIDER_LABELS[provider] });

  await writeAuditLog({
    actorId: session.userId,
    action: 'OAUTH_UNLINK',
    entityType: 'user',
    entityId: session.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
    after: { provider, reauth: proof.method, otherSessionsRevoked: revoked },
  });

  return mfaJson({ ok: true });
}
