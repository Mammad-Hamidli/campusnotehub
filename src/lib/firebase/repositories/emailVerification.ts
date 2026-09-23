import { hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, forFirestore } from '../convert';

/**
 * Email verification tokens: `emailVerifications/{hash(token)}`.
 *
 * ===========================================================================
 * A LINK ALONE NEVER VERIFIES ANYTHING
 * ===========================================================================
 * A verified email is what lets Google link AUTOMATICALLY to an account
 * (see lib/auth/oauth/callback.ts, rule 2a). That makes verification a target
 * for the pre-hijack attack:
 *
 *   1. A squatter registers victim@x and asks for a verification email.
 *   2. The email goes to the VICTIM, who clicks it - or their mail provider's
 *      link scanner (Outlook Safe Links, corporate gateways) opens it for them.
 *   3. If opening the link verified the address, the squatter's account would
 *      now be "verified", and the victim's next Google sign-in would be linked
 *      straight into it.
 *
 * So redeeming a token REQUIRES A SIGNED-IN SESSION OF THE ACCOUNT IT WAS
 * ISSUED TO. The squatter never sees the link (it is in the victim's inbox);
 * the victim is not signed in to the squatter's account. Neither can complete
 * it. A scanner has no session at all. What verification proves is exactly
 * the thing auto-linking relies on: the same person controls the account AND
 * the mailbox.
 *
 * Also bound to the ADDRESS it was sent to - a token issued for one email can
 * never verify another - and single use, 24 hours, one live token per account
 * (issuing a new one revokes the previous ones).
 *
 * The raw token exists only in the email itself; this collection holds its
 * keyed hash. (A copy also sits in the email outbox while a failed send
 * awaits retry. That copy is inert for the same reason as a stolen email: it
 * needs the owner's session.)
 */

export type EmailVerificationRecord = {
  userId: string;
  email: string;
  createdAt: Date;
  expiresAt: Date;
};

export const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60_000;

const tokens = () => adminDb().collection(COLLECTIONS.emailVerifications);
const users = () => adminDb().collection(COLLECTIONS.users);

/** Creates a token for the account's current address and revokes any earlier one. */
export async function issueEmailVerification(userId: string, email: string): Promise<string> {
  const token = newOpaqueToken();
  const now = new Date();
  const previous = await tokens().where('userId', '==', userId).get();
  await adminDb().runTransaction(async (tx) => {
    for (const doc of previous.docs) tx.delete(doc.ref);
    tx.create(
      tokens().doc(hashToken(token)),
      forFirestore({
        userId,
        email: email.toLowerCase(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + EMAIL_TOKEN_TTL_MS),
      } satisfies EmailVerificationRecord),
    );
  });
  return token;
}

export type RedeemResult = 'verified' | 'already_verified' | 'invalid' | 'wrong_account' | 'email_changed';

/**
 * Redeems a token for the SIGNED-IN user. The caller passes the session's
 * user id; nothing in the token itself can choose the account.
 *
 * `wrong_account` leaves the token alive: someone else opening the link on a
 * shared computer must not burn it for its rightful owner. It reveals only
 * that the token is valid for some other account - to a person holding the
 * email it came in.
 */
export async function redeemEmailVerification(token: string, sessionUserId: string): Promise<RedeemResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return 'invalid';
  const ref = tokens().doc(hashToken(token));

  return adminDb().runTransaction(async (tx) => {
    const record = docToObject<EmailVerificationRecord>(await tx.get(ref)) as
      | (EmailVerificationRecord & { id: string })
      | null;
    if (!record) return 'invalid';
    if (record.expiresAt <= new Date()) {
      tx.delete(ref);
      return 'invalid';
    }
    if (record.userId !== sessionUserId) return 'wrong_account';

    const user = await tx.get(users().doc(sessionUserId));
    if (!user.exists || user.get('deletedAt')) {
      tx.delete(ref);
      return 'invalid';
    }
    // The address changed since the email was sent: this token proves the OLD one.
    if (String(user.get('email') ?? '').toLowerCase() !== record.email) {
      tx.delete(ref);
      return 'email_changed';
    }
    tx.delete(ref);
    if (user.get('emailVerifiedAt')) return 'already_verified';
    tx.update(users().doc(sessionUserId), forFirestore({ emailVerifiedAt: new Date(), updatedAt: new Date() }));
    return 'verified';
  });
}
