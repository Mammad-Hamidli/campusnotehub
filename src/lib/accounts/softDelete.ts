import 'server-only';
import type { NextRequest } from 'next/server';
import { AccountStatus, UserRole } from '@/lib/enums';
import { countUsers, findUserById, updateUser } from '@/lib/firebase/repositories/users';
import { revokeUserSessions } from '@/lib/firebase/repositories/sessions';
import { writeModerationAction } from '@/lib/firebase/repositories/moderation';
import { adminAudit } from '@/lib/auth/admin';
import { sendEmailAsync } from '@/lib/email/send';

export class AccountDeletionError extends Error {
  constructor(readonly messageKey: string, readonly status: number) {
    super(messageKey);
  }
}

/**
 * Soft-deletes an account on an administrator's authority. The ONE
 * implementation, used by both paths that delete:
 *
 *   - DELETE /api/admin/users/:userId            (source: ADMIN)
 *   - approving a user's own deletion request    (source: USER_REQUEST)
 *
 * so a request approved from the review queue is exactly the deletion the
 * users panel performs - same guards, same record, same email.
 *
 * Soft, not hard: the row and its identifier hashes stay (so a banned identity
 * cannot be recycled and the ledger and audit trail stay intact), sessions are
 * revoked, and requireSession refuses a DELETED account from then on. See the
 * note on the admin DELETE route for the full reasoning.
 */
export async function softDeleteAccount(p: {
  userId: string;
  actorId: string;
  reason: string;
  source: 'ADMIN' | 'USER_REQUEST';
  request: NextRequest;
}): Promise<Date> {
  const target = await findUserById(p.userId);
  if (!target || target.deletedAt) throw new AccountDeletionError('errors.notFound', 404);
  if (target.id === p.actorId) throw new AccountDeletionError('admin.users.errors.cannotActOnSelf', 409);

  // The platform must never be left without an administrator.
  if (target.role === UserRole.ADMIN) {
    const admins = await countUsers({ role: UserRole.ADMIN, deletedAt: null });
    if (admins - 1 <= 0) throw new AccountDeletionError('admin.users.errors.lastAdmin', 409);
  }

  const now = new Date();

  // The act, then the record: an audit row for a deletion that then failed
  // would be a false statement in the one table that must be true.
  await updateUser(p.userId, { deletedAt: now, accountStatus: AccountStatus.DELETED });
  await revokeUserSessions(p.userId);
  sendEmailAsync(target.email, 'accountDeleted', { nickname: target.nickname });

  await writeModerationAction({
    moderatorId: p.actorId,
    targetType: 'user',
    targetId: p.userId,
    action: 'delete',
    reason: p.reason,
  });

  await adminAudit({
    actorId: p.actorId,
    action: 'ADMIN_USER_DELETED',
    entityType: 'user',
    entityId: p.userId,
    before: { accountStatus: target.accountStatus, deletedAt: null },
    after: { accountStatus: AccountStatus.DELETED, reason: p.reason, source: p.source },
    request: p.request,
  });

  return now;
}
