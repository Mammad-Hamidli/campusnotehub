import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminRevokeSessionsSchema } from '@/server/validators/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/admin/users/:userId/sessions - force logout.
 *
 * Revokes every live refresh token for the account. This uses the session
 * table the auth system already owns rather than adding a "force logout" flag
 * somewhere new: rotateSession refuses a revoked row, so the next refresh
 * fails and the user is signed out everywhere.
 *
 * HONEST LIMITATION, and it is worth stating because "force logout" sounds
 * absolute: the access token is a stateless JWT with no server-side check
 * beyond requireSession's live account lookup. A user holding an unexpired
 * access token keeps read access until it expires - at most ACCESS_TTL, 15
 * minutes by default. Immediate lockout is what account status is for, and
 * suspending an account revokes its sessions as part of the same transaction.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const { userId } = await params;
    const parsed = adminRevokeSessionsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }

    const now = new Date();
    let revoked = 0;

    await db.$transaction(async (tx) => {
      const result = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      revoked = result.count;

      await tx.moderationAction.create({
        data: {
          moderatorId: actor.id,
          targetType: 'user',
          targetId: userId,
          action: 'sessions:revoke',
          reason: parsed.data.reason,
          metadata: { revoked },
        },
      });

      await adminAudit({
        tx,
        actorId: actor.id,
        action: 'ADMIN_SESSIONS_REVOKED',
        entityType: 'user',
        entityId: userId,
        after: { revoked, reason: parsed.data.reason },
        request,
      });
    });

    return NextResponse.json({ ok: true, revoked });
  });
}
