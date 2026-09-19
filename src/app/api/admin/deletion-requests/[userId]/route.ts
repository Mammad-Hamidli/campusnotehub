import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NotificationType } from '@/lib/enums';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import {
  DeletionRequestError,
  closeDeletionRequest,
  findDeletionRequest,
} from '@/lib/firebase/repositories/deletionRequests';
import { findUserById } from '@/lib/firebase/repositories/users';
import { AccountDeletionError, softDeleteAccount } from '@/lib/accounts/softDelete';
import { enqueueNotification } from '@/lib/notifications/dispatch';
import { sendEmailAsync } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Same shape and rule as the other review decisions: a rejection needs a reason, because it is emailed. */
const decisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((d) => d.decision === 'APPROVE' || (d.reason?.length ?? 0) >= 5, {
    path: ['reason'],
    message: 'admin.reviews.errors.reasonRequired',
  });

/**
 * PATCH /api/admin/deletion-requests/:userId  { decision, reason? }
 *
 *   APPROVE - runs softDeleteAccount(), the same deletion as the users panel
 *             (self-action and last-admin guards included), then closes the
 *             request. The account-deleted email goes out from there.
 *   REJECT  - closes the request and tells the user why, by email and in-app.
 *
 * ADMIN tier, matching DELETE /api/admin/users/:userId.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const { userId } = await params;
    const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { decision, reason } = parsed.data;

    const pending = await findDeletionRequest(userId);
    if (!pending) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    if (pending.status !== 'PENDING') {
      return NextResponse.json({ error: 'admin.reviews.errors.alreadyDecided' }, { status: 409 });
    }

    try {
      if (decision === 'APPROVE') {
        /**
         * Delete first, then close. If the deletion is refused (last admin,
         * already gone) the request stays PENDING and visible, instead of
         * being marked approved for an account that still exists.
         */
        await softDeleteAccount({
          userId,
          actorId: actor.id,
          reason: reason || 'Deletion requested by the account owner.',
          source: 'USER_REQUEST',
          request,
        });
        await closeDeletionRequest(userId, 'APPROVED', actor.id, reason || null);
      } else {
        await closeDeletionRequest(userId, 'REJECTED', actor.id, reason!);

        const user = await findUserById(userId);
        if (user && !user.deletedAt) {
          sendEmailAsync(user.email, 'accountDeletionRejected', { nickname: user.nickname, reason: reason! });
          await enqueueNotification({
            userId,
            type: NotificationType.SYSTEM,
            titleKey: 'notifications.deletionRequest.rejectedTitle',
            bodyKey: 'notifications.deletionRequest.rejectedBody',
            linkUrl: '/settings?tab=account',
            // The dedicated email above already carries the reason.
            skipEmail: true,
          });
        }

        await adminAudit({
          actorId: actor.id,
          action: 'ADMIN_DELETION_REQUEST_REJECTED',
          entityType: 'user',
          entityId: userId,
          after: { reason },
          request,
        });
      }
    } catch (error) {
      if (error instanceof AccountDeletionError || error instanceof DeletionRequestError) {
        return NextResponse.json({ error: error.messageKey }, { status: error.status });
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  });
}
