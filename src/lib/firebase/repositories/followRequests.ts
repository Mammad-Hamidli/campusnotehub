import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docsToObjects, forFirestore } from '../convert';
import { writeFollowEdges } from './follows';

/**
 * Follow requests.
 *
 * Following is consent-based: POST /api/users/:nickname/follow files a request
 * and the target accepts or rejects it in-app (/notifications). The request is
 * ONE document keyed `{requesterId}__{targetId}`, so asking twice is the same
 * document rather than a duplicate.
 *
 * Accept and reject both DELETE the request. Nothing records a rejection, and
 * that is the rule, not an omission: a rejected requester may ask again at
 * once, with no cooldown and no block.
 */

export type FollowRequestRecord = {
  id: string;
  requesterId: string;
  targetId: string;
  createdAt: Date;
};

const requests = () => adminDb().collection(COLLECTIONS.followRequests);

export function followRequestId(requesterId: string, targetId: string): string {
  return `${requesterId}__${targetId}`.replace(/[/.]/g, '_');
}

/** 'created' for a new request, 'exists' when one is already pending. */
export async function createFollowRequest(requesterId: string, targetId: string): Promise<'created' | 'exists'> {
  const ref = requests().doc(followRequestId(requesterId, targetId));
  try {
    await ref.create(forFirestore({ requesterId, targetId, createdAt: new Date() }));
    return 'created';
  } catch (error) {
    if ((error as { code?: number }).code === 6) return 'exists'; // ALREADY_EXISTS
    throw error;
  }
}

export async function cancelFollowRequest(requesterId: string, targetId: string): Promise<void> {
  await requests().doc(followRequestId(requesterId, targetId)).delete();
}

export async function hasPendingRequest(requesterId: string, targetId: string): Promise<boolean> {
  return (await requests().doc(followRequestId(requesterId, targetId)).get()).exists;
}

/** Incoming requests, newest first. Equality only: no composite index. */
export async function listIncomingRequests(targetId: string, take = 100): Promise<FollowRequestRecord[]> {
  const snap = await requests().where('targetId', '==', targetId).limit(take).get();
  return (docsToObjects<FollowRequestRecord>(snap.docs) as FollowRequestRecord[]).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

export async function countIncomingRequests(targetId: string): Promise<number> {
  return (await requests().where('targetId', '==', targetId).count().get()).data().count;
}

/**
 * Accepts: the request is consumed and both follow edges are written in the
 * same transaction, so a double-tap or a racing reject cannot leave an edge
 * without its request having existed. 'missing' when it was already answered
 * or withdrawn.
 */
export async function acceptFollowRequest(targetId: string, requesterId: string): Promise<'accepted' | 'missing'> {
  const ref = requests().doc(followRequestId(requesterId, targetId));
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'missing' as const;
    tx.delete(ref);
    writeFollowEdges(tx, requesterId, targetId);
    return 'accepted' as const;
  });
}

/** Rejects by deleting - see the header: no trace, so the requester may ask again. */
export async function rejectFollowRequest(targetId: string, requesterId: string): Promise<'rejected' | 'missing'> {
  const ref = requests().doc(followRequestId(requesterId, targetId));
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'missing' as const;
    tx.delete(ref);
    return 'rejected' as const;
  });
}
