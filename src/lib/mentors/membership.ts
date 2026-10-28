import { UserRole } from '@/lib/enums';

/**
 * Who is a mentor ACCOUNT, and since when.
 *
 * Two facts, deliberately kept apart:
 *
 *   users.role === MENTOR   the account signed up as, or was promoted to, a
 *                           mentor. This is the RBAC input (permissions.can).
 *   users.mentorSince       when that happened. It is the join date the
 *                           mentor panel shows and the anchor of the monthly
 *                           fee reminder (src/lib/mentors/billing.ts).
 *
 * `mentorSince` also carries mentor access for the roles an approval does NOT
 * overwrite: an ALUMNI or TEACHER account whose application is approved keeps
 * its role, because the role is itself a claim (graduated; employed by a
 * university) that other code reads. Being a mentor must not erase it.
 */

/**
 * The role an approved application leaves the applicant with. Only STUDENT is
 * promoted: ALUMNI and TEACHER keep their role (see above), and staff are
 * never demoted by a mentoring decision.
 */
export function roleAfterMentorApproval(role: UserRole): UserRole {
  return role === UserRole.STUDENT ? UserRole.MENTOR : role;
}

/**
 * The `mentorSince` change that accompanies an admin setting `nextRole`.
 *
 * Granting MENTOR stamps the join date once; re-granting keeps the original,
 * so the fee schedule does not jump. Taking MENTOR away clears it - otherwise
 * the stamp alone would keep the mentor panel open (see can()).
 */
export function mentorSincePatchForRoleChange(
  target: { role: UserRole; mentorSince?: Date | null },
  nextRole: UserRole,
  now: Date,
): { mentorSince?: Date | null } {
  if (nextRole === UserRole.MENTOR) return target.mentorSince ? {} : { mentorSince: now };
  if (target.role === UserRole.MENTOR) return { mentorSince: null };
  return {};
}

/**
 * The join date to show and bill from. A MENTOR account written before
 * `mentorSince` existed falls back to its signup date, which is what the
 * backfill (scripts/backfill-mentor-since.mts) writes for it anyway.
 */
export function mentorJoinDate(user: {
  role: UserRole;
  mentorSince?: Date | null;
  createdAt: Date;
  mentorRegistrationStatus?: MentorRegistrationStatus | null;
}): Date | null {
  // Not activated yet: no fee is owed, so there is no join date to bill from.
  if (mentorActivationPending(user)) return null;
  return user.mentorSince ?? (user.role === UserRole.MENTOR ? user.createdAt : null);
}

export type MentorRegistrationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * A mentor-track signup that has not been activated yet.
 *
 * `/mentors/join` writes `mentorRegistrationStatus: PENDING`; it only becomes
 * APPROVED when a moderator approves a payment receipt
 * (decideMentorPaymentReceipt). Until then the account can open its panel -
 * that is where it is told to pay - but it cannot apply, be booked, or start
 * the fee clock. `null` is every account that never went through that
 * signup (students, legacy mentors), which this gate leaves alone.
 */
export function mentorActivationPending(user: { mentorRegistrationStatus?: MentorRegistrationStatus | null }): boolean {
  return user.mentorRegistrationStatus === 'PENDING' || user.mentorRegistrationStatus === 'REJECTED';
}
