import { constantTimeEqual, hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, forFirestore } from '../convert';

/**
 * Password reset tokens: `passwordResets/{hash(token)}`.
 *
 * ===========================================================================
 * WHAT A RESET TOKEN IS
 * ===========================================================================
 * 256 bits from the CSPRNG (newOpaqueToken), delivered ONLY in the email. The
 * database holds its keyed hash (HMAC-SHA-256 with the PII pepper) as the
 * document id, so a dump of this collection - or of a backup - yields nothing
 * that can be typed into /reset-password. A plain SHA-256 would already be
 * irreversible for a 256-bit input; the HMAC is simply the helper every other
 * token in this codebase goes through.
 *
 * ===========================================================================
 * FOUR WAYS A TOKEN DIES
 * ===========================================================================
 *   1. It is redeemed - deleted in the SAME transaction that writes the new
 *      hash, so two simultaneous submissions cannot both succeed.
 *   2. It expires - 30 minutes. Checked on read; the TTL policy on
 *      `expiresAt` only garbage-collects.
 *   3. A newer one is issued - one live token per account, so only the
 *      newest email in the inbox works.
 *   4. The password changes by ANY other route. Each token carries a stamp of
 *      the password hash it was issued against (`credentialStamp`), and the
 *      argon2id hash is salted, so every change - a settings change, an admin
 *      reset, another reset link - moves the stamp and strands every token
 *      issued before it, without having to find and delete them.
 *
 * Also bound to the ADDRESS it was sent to: if the account's email changed in
 * the meantime, the old inbox no longer controls the account.
 *
 * A copy of the raw token sits in `emailOutbox` while a failed send waits for
 * its retry. That collection is server-only like this one, and the copy obeys
 * the same four rules, because the check is against THIS collection.
 */

export type PasswordResetRecord = {
  userId: string;
  email: string;
  /** hashToken(passwordHash) when issued. Never the hash itself. */
  credentialStamp: string;
  createdAt: Date;
  expiresAt: Date;
};

export const PASSWORD_RESET_TTL_MS = 30 * 60_000;

/** newOpaqueToken(): 32 bytes, base64url, no padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const tokens = () => adminDb().collection(COLLECTIONS.passwordResets);
const users = () => adminDb().collection(COLLECTIONS.users);
const credentials = () => adminDb().collection('credentials');

const stampOf = (passwordHash: string) => hashToken(`credential:${passwordHash}`);

/** Creates a token for the account and revokes every earlier one. */
export async function issuePasswordReset(user: {
  userId: string;
  email: string;
  passwordHash: string;
}): Promise<string> {
  const token = newOpaqueToken();
  const now = new Date();
  const previous = await tokens().where('userId', '==', user.userId).get();
  await adminDb().runTransaction(async (tx) => {
    for (const doc of previous.docs) tx.delete(doc.ref);
    tx.create(
      tokens().doc(hashToken(token)),
      forFirestore({
        userId: user.userId,
        email: user.email.toLowerCase(),
        credentialStamp: stampOf(user.passwordHash),
        createdAt: now,
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      } satisfies PasswordResetRecord),
    );
  });
  return token;
}

/**
 * A cheap, NON-authoritative "is this worth hashing a password for?".
 *
 * The reset route calls this before argon2id, so a stream of garbage tokens
 * costs a document read each instead of 19 MiB of memory-hard hashing each.
 * redeemPasswordReset() re-checks everything inside its transaction.
 */
export async function isPasswordResetLive(token: string): Promise<boolean> {
  if (!TOKEN_SHAPE.test(token)) return false;
  const snap = await tokens().doc(hashToken(token)).get();
  const expiresAt = docToObject<PasswordResetRecord>(snap)?.expiresAt;
  return !!expiresAt && expiresAt > new Date();
}

export type RedeemPasswordResetResult = { ok: true; userId: string } | { ok: false };

/**
 * Consumes the token and installs `newPasswordHash`, atomically.
 *
 * The caller hashes BEFORE calling (argon2id does not belong inside a
 * transaction that may be retried). Every failure is the same `{ ok: false }`:
 * the person holding a dead link needs one instruction - request a new one -
 * and the reason is not theirs to learn.
 *
 * A token that is found but unusable is deleted on the way out, so it cannot
 * be probed twice.
 */
export async function redeemPasswordReset(token: string, newPasswordHash: string): Promise<RedeemPasswordResetResult> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false };
  const ref = tokens().doc(hashToken(token));

  return adminDb().runTransaction(async (tx) => {
    const record = docToObject<PasswordResetRecord>(await tx.get(ref)) as PasswordResetRecord | null;
    if (!record) return { ok: false } as const;

    // Every read happens before the first write - a Firestore transaction rule.
    const [user, credential] = await Promise.all([
      tx.get(users().doc(record.userId)),
      tx.get(credentials().doc(record.userId)),
    ]);
    const currentHash = credential.get('passwordHash');
    const status = user.get('accountStatus');

    const usable =
      record.expiresAt > new Date() &&
      user.exists &&
      !user.get('deletedAt') &&
      status !== 'BANNED' &&
      status !== 'DELETED' &&
      String(user.get('email') ?? '').toLowerCase() === record.email &&
      typeof currentHash === 'string' &&
      constantTimeEqual(stampOf(currentHash), record.credentialStamp);

    tx.delete(ref);
    if (!usable) return { ok: false } as const;

    const now = new Date();
    tx.update(credentials().doc(record.userId), forFirestore({ passwordHash: newPasswordHash, passwordChangedAt: now }));
    // Proving control of the mailbox forgives the password lockout: the
    // lockout exists to stop guessing, and nobody is guessing any more.
    tx.update(users().doc(record.userId), forFirestore({ failedLoginCount: 0, lockedUntil: null, updatedAt: now }));
    return { ok: true, userId: record.userId } as const;
  });
}

/** Deletes every outstanding token for an account - after a password change by any other route. */
export async function revokePasswordResets(userId: string): Promise<void> {
  const snap = await tokens().where('userId', '==', userId).get();
  if (snap.empty) return;
  const batch = adminDb().batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}
