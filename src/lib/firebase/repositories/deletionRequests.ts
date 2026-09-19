import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';

/**
 * Account deletion requests.
 *
 * A user cannot delete their own account directly: they file a request, and an
 * administrator reviews it in /admin/reviews and either approves it (which runs
 * the same soft delete as the admin panel, see src/lib/accounts/softDelete.ts)
 * or rejects it with a reason. Manual review exists because deletion is the
 * one account action that cannot be walked back by the user, and because an
 * account can hold things that need a human decision first - a wallet balance,
 * open bookings, notes other people have paid for.
 *
 * One document per user, keyed by user id, like mentorApplications: "does this
 * user have an open request" is a keyed read, and a new request after a
 * rejection or cancellation replaces the old one instead of piling up.
 */

export type DeletionRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type DeletionRequestRecord = {
  id: string;
  userId: string;
  status: DeletionRequestStatus;
  /** The user's own words, optional. Shown to the reviewing admin only. */
  reason: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedById: string | null;
  /** Admin's note; for a rejection it is emailed to the user. */
  decisionNote: string | null;
};

export class DeletionRequestError extends Error {
  constructor(readonly messageKey: string, readonly status: number) {
    super(messageKey);
  }
}

const requests = () => adminDb().collection(COLLECTIONS.accountDeletionRequests);

export async function findDeletionRequest(userId: string): Promise<DeletionRequestRecord | null> {
  return docToObject<DeletionRequestRecord>(await requests().doc(userId).get()) as DeletionRequestRecord | null;
}

/** Files a request. Refused while one is already pending, so a double click is one request. */
export async function createDeletionRequest(userId: string, reason: string | null): Promise<DeletionRequestRecord> {
  const ref = requests().doc(userId);
  const record = {
    userId,
    status: 'PENDING' as const,
    reason,
    requestedAt: new Date(),
    decidedAt: null,
    decidedById: null,
    decisionNote: null,
  };
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()!.status === 'PENDING') {
      throw new DeletionRequestError('settings.deletion.errors.alreadyPending', 409);
    }
    tx.set(ref, forFirestore(record));
  });
  return { id: userId, ...record };
}

/**
 * Moves a PENDING request to a final state. Throws if it is no longer pending,
 * so two admins deciding at once (or a user cancelling while an admin
 * approves) resolve to exactly one outcome.
 */
export async function closeDeletionRequest(
  userId: string,
  status: Exclude<DeletionRequestStatus, 'PENDING'>,
  actorId: string,
  note: string | null,
): Promise<void> {
  const ref = requests().doc(userId);
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new DeletionRequestError('errors.notFound', 404);
    if (snap.data()!.status !== 'PENDING') {
      throw new DeletionRequestError('admin.reviews.errors.alreadyDecided', 409);
    }
    tx.update(ref, forFirestore({ status, decidedAt: new Date(), decidedById: actorId, decisionNote: note }));
  });
}

export async function listDeletionRequests(
  status: DeletionRequestStatus,
  take = 100,
): Promise<DeletionRequestRecord[]> {
  // Equality only: no composite index needed. Ordered in memory, oldest first,
  // because the queue should be worked in the order people asked.
  const snap = await requests().where('status', '==', status).limit(take).get();
  return (docsToObjects<DeletionRequestRecord>(snap.docs) as DeletionRequestRecord[]).sort(
    (a, b) => a.requestedAt.getTime() - b.requestedAt.getTime(),
  );
}
