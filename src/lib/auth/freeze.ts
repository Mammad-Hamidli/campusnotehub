import { AccountStatus } from '@/lib/enums';
import { findUserById, updateUser } from '@/lib/firebase/repositories/users';
import { revokeUserSessions } from '@/lib/firebase/repositories/sessions';

/**
 * Temporary account freeze.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FREEZE IS, IN ONE LINE
 * ---------------------------------------------------------------------------
 * AccountStatus.SUSPENDED plus an expiry, plus every live session revoked.
 *
 * It is NOT a new AccountStatus member. SUSPENDED already means "temporary" in
 * this schema and permissions.ts already routes it to the read-only capability
 * set, so a FROZEN member would have meant auditing every existing status
 * comparison in the codebase for a case it had never seen - with the failure
 * mode being that a missed comparison silently grants a frozen account full
 * access. Reusing SUSPENDED means the enforcement was already correct before
 * this file existed.
 *
 * ---------------------------------------------------------------------------
 * WHY SESSIONS ARE REVOKED, NOT JUST THE STATUS FLIPPED
 * ---------------------------------------------------------------------------
 * requireSession() reads live account state on every request, so a frozen user
 * would lose write capabilities immediately either way. Revoking anyway is
 * belt and braces and it makes the freeze VISIBLE: the user is signed out and
 * meets the notice, rather than silently discovering that buttons no longer
 * work. It also matches what the existing status-change handler already does.
 *
 * ---------------------------------------------------------------------------
 * WHY THE `tx` PARAMETER IS GONE
 * ---------------------------------------------------------------------------
 * These functions used to accept a `Prisma.TransactionClient` so a caller could
 * fold the freeze into a larger transaction. Firestore has no equivalent: a
 * transaction handle cannot be passed across module boundaries and reused,
 * because every read in a Firestore transaction must happen before every write
 * and the SDK enforces that on the handle itself. Threading one through here
 * would mean these functions could only ever be called from inside a
 * transaction - the opposite of what the parameter was for.
 *
 * The order below is chosen so an interruption fails SAFE. The status is
 * written first and the sessions revoked second, so a crash between them
 * leaves an account that is already SUSPENDED with sessions still live - and
 * requireSession() re-reads account state on every request, so those sessions
 * have already lost their write capabilities. The reverse order would leave
 * the account signed out but still ACTIVE, which is the failure that lets
 * someone sign straight back in with full access.
 */

export type FreezeInput = {
  userId: string;
  actorId: string;
  reason: string;
  /**
   * When the freeze lifts. NULL means indefinite, which is the pre-existing
   * suspension behaviour and still reachable from the same UI.
   */
  until: Date | null;
};

export async function freezeAccount(input: FreezeInput): Promise<void> {
  const now = new Date();

  // Status first - see the note above on failing safe.
  await updateUser(input.userId, {
    accountStatus: AccountStatus.SUSPENDED,
    frozenUntil: input.until,
    frozenReason: input.reason,
    frozenById: input.actorId,
    frozenAt: now,
  });

  await revokeUserSessions(input.userId);
}

/**
 * Lifts a freeze.
 *
 * Deliberately refuses to touch a BANNED account. A ban is issued with
 * blocklist rows attached, so flipping the column back to ACTIVE would produce
 * an account that looks live but whose owner is refused at every signup and
 * login check - a state no code path expects to find. This mirrors the same
 * guard the existing status-change handler applies, so "unfreeze" cannot
 * become a back door around it.
 *
 * Returns false when there was nothing to lift, so the caller can answer 409
 * rather than reporting a success that changed nothing.
 */
export async function unfreezeAccount(input: { userId: string }): Promise<boolean> {
  const target = await findUserById(input.userId);

  if (!target || target.deletedAt) return false;
  if (target.accountStatus === AccountStatus.BANNED || target.accountStatus === AccountStatus.DELETED) {
    return false;
  }
  if (target.accountStatus !== AccountStatus.SUSPENDED) return false;

  await updateUser(input.userId, {
    accountStatus: AccountStatus.ACTIVE,
    frozenUntil: null,
    frozenReason: null,
    frozenAt: null,
    frozenById: null,
  });

  return true;
}

/**
 * Describes a freeze for the client.
 *
 * One shared serialiser so the admin table, the admin detail modal and the
 * user's own /api/me response cannot disagree about whether an account is
 * frozen - which is the usual way a "frozen" badge ends up showing on an
 * account that is already active again.
 */
export type FreezeState = {
  frozen: boolean;
  until: string | null;
  reason: string | null;
  at: string | null;
  /** True when `until` has passed but nothing has lifted it yet. */
  expired: boolean;
};

export function freezeState(user: {
  accountStatus: AccountStatus;
  frozenUntil?: Date | null;
  frozenReason?: string | null;
  frozenAt?: Date | null;
}): FreezeState {
  const frozen = user.accountStatus === AccountStatus.SUSPENDED;
  const until = user.frozenUntil ?? null;
  return {
    frozen,
    until: until ? until.toISOString() : null,
    reason: user.frozenReason ?? null,
    at: user.frozenAt ? user.frozenAt.toISOString() : null,
    expired: Boolean(frozen && until && until <= new Date()),
  };
}
