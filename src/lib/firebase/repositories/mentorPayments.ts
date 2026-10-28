import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';
import { UserRole } from '@/lib/enums';
import { mentorActivationPending } from '@/lib/mentors/membership';

export type MentorPaymentStatus = 'PENDING' | 'APPROVED' | 'INVALID';
export type MentorPaymentReceipt = {
  id: string;
  userId: string;
  status: MentorPaymentStatus;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  attachmentNames: string[];
  decidedAt: Date | null;
  decidedById: string | null;
};

const receipts = () => adminDb().collection(COLLECTIONS.mentorPaymentReceipts);

export async function listMentorPaymentReceipts(status: MentorPaymentStatus = 'PENDING', take = 100) {
  const snap = await receipts().where('status', '==', status).limit(take).get();
  return (docsToObjects<MentorPaymentReceipt>(snap.docs) as MentorPaymentReceipt[]).sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
  );
}

/** Whether the account has a receipt waiting for a moderator. Equality-only. */
export async function hasPendingMentorPaymentReceipt(userId: string): Promise<boolean> {
  const snap = await receipts().where('userId', '==', userId).where('status', '==', 'PENDING').limit(1).get();
  return !snap.empty;
}

export async function findMentorPaymentReceipt(id: string) {
  return docToObject<MentorPaymentReceipt>(await receipts().doc(id).get()) as MentorPaymentReceipt | null;
}

/**
 * The moderator's decision on one receipt, plus what it does to the account.
 *
 * APPROVED on an account that is still waiting for activation
 * (mentorActivationPending) activates it in the SAME transaction: status
 * APPROVED, role MENTOR for a STUDENT, and `mentorSince` stamped now - the fee
 * clock starts on the day the first payment is confirmed. A receipt for an
 * already active account (a monthly renewal) changes only the receipt.
 *
 * INVALID never touches the account: the mentor is emailed and can send a new
 * receipt, which lands back in the queue.
 */
export async function decideMentorPaymentReceipt(
  id: string,
  decision: Exclude<MentorPaymentStatus, 'PENDING'>,
  actorId: string,
): Promise<(MentorPaymentReceipt & { activated: boolean }) | null> {
  const ref = receipts().doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    if (snap.get('status') !== 'PENDING') throw new Error('ALREADY_DECIDED');
    const userId = snap.get('userId') as string;
    const userRef = adminDb().collection(COLLECTIONS.users).doc(userId);
    // All reads before any write: a Firestore transaction requires it.
    const userSnap = decision === 'APPROVED' ? await tx.get(userRef) : null;

    const now = new Date();
    tx.update(ref, forFirestore({ status: decision, decidedAt: now, decidedById: actorId }));

    let activated = false;
    if (
      userSnap?.exists &&
      !userSnap.get('deletedAt') &&
      mentorActivationPending({ mentorRegistrationStatus: userSnap.get('mentorRegistrationStatus') })
    ) {
      const role = userSnap.get('role') as UserRole;
      tx.update(userRef, forFirestore({
        mentorRegistrationStatus: 'APPROVED',
        ...(role === UserRole.STUDENT ? { role: UserRole.MENTOR } : {}),
        ...(userSnap.get('mentorSince') ? {} : { mentorSince: now }),
        updatedAt: now,
      }));
      activated = true;
    }
    return {
      id,
      ...(snap.data() as Omit<MentorPaymentReceipt, 'id'>),
      status: decision,
      decidedAt: now,
      decidedById: actorId,
      activated,
    };
  });
}
