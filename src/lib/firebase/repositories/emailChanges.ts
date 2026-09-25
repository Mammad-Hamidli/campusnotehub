import { hashEmail, hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, forFirestore } from '../convert';
import { changeEmailTx } from './users';

/**
 * Email changes in flight: `emailChanges/{hash(token)}`.
 *
 * Two proofs, in order. Starting one (POST /api/me/email/change) re-proves
 * the account holder - password, authenticator code, or a fresh Google
 * sign-in (reauthenticate()). Finishing it proves control of the NEW address:
 * the link mailed there, opened by the same signed-in account. Only the HMAC
 * of the token is stored, the same as email verification and password
 * resets, so a database read never yields a usable link.
 *
 * One pending change per account: issuing a new one deletes the old.
 */

export type EmailChangeRecord = {
  userId: string;
  /** The address the account had when the change was requested. */
  fromEmail: string;
  toEmail: string;
  createdAt: Date;
  expiresAt: Date;
};

export const EMAIL_CHANGE_TTL_MS = 60 * 60_000;

const changes = () => adminDb().collection(COLLECTIONS.emailChanges);

export async function issueEmailChange(userId: string, fromEmail: string, toEmail: string): Promise<string> {
  const token = newOpaqueToken();
  const now = new Date();
  const previous = await changes().where('userId', '==', userId).get();
  await adminDb().runTransaction(async (tx) => {
    for (const doc of previous.docs) tx.delete(doc.ref);
    tx.create(
      changes().doc(hashToken(token)),
      forFirestore({
        userId,
        fromEmail: fromEmail.toLowerCase(),
        toEmail: toEmail.toLowerCase(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + EMAIL_CHANGE_TTL_MS),
      } satisfies EmailChangeRecord),
    );
  });
  return token;
}

export type EmailChangeResult =
  | { status: 'changed'; fromEmail: string; toEmail: string }
  | { status: 'invalid' | 'wrong_account' | 'stale' | 'taken' };

/**
 * Consumes the token and moves the account, in ONE transaction: a token that
 * was used cannot be used again, and a move that failed leaves the token
 * burned only when retrying could never succeed.
 */
export async function redeemEmailChange(token: string, sessionUserId: string): Promise<EmailChangeResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: 'invalid' };
  const ref = changes().doc(hashToken(token));

  return adminDb().runTransaction(async (tx): Promise<EmailChangeResult> => {
    const record = docToObject<EmailChangeRecord>(await tx.get(ref)) as (EmailChangeRecord & { id: string }) | null;
    if (!record) return { status: 'invalid' };
    if (record.expiresAt <= new Date()) {
      tx.delete(ref);
      return { status: 'invalid' };
    }
    // Kept, so signing in as the right account and reopening the link works.
    if (record.userId !== sessionUserId) return { status: 'wrong_account' };

    const moved = await changeEmailTx(tx, sessionUserId, record.fromEmail, {
      value: record.toEmail,
      hash: hashEmail(record.toEmail),
    });
    tx.delete(ref);
    if (moved === 'stale') return { status: 'stale' };
    if (moved === 'email') return { status: 'taken' };
    return { status: 'changed', fromEmail: record.fromEmail, toEmail: record.toEmail };
  });
}
