import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docsToObjects, forFirestore } from '../convert';

/**
 * Moderation actions - the record of what staff did to whom.
 *
 * Same posture as the audit log next door: one writer, creation only, no
 * update and no delete exposed, and `createdAt` stamped server-side so an
 * entry cannot be backdated. The security rules deny the collection to every
 * client, staff included - it is read back through the server so the moderator
 * name can be joined on and the response narrowed.
 *
 * This is separate from `auditLogs` on purpose and both are written for a
 * moderation event. The audit log is the low-level, high-volume trail of every
 * state change; this is the deliberate human decision, with the reason the
 * moderator typed. Collapsing them would either bury decisions in noise or
 * force every audit row to carry a reason it does not have.
 */

export type ModerationActionRecord = {
  id: string;
  moderatorId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  metadata: unknown;
  createdAt: Date;
};

const actions = () => adminDb().collection(COLLECTIONS.moderationActions);

/** The ONLY writer. Creates; never updates. */
export async function writeModerationAction(entry: {
  moderatorId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  metadata?: unknown;
}): Promise<void> {
  await actions().add(
    forFirestore({
      moderatorId: entry.moderatorId,
      targetType: entry.targetType,
      targetId: entry.targetId,
      action: entry.action,
      reason: entry.reason,
      metadata: entry.metadata ?? null,
      createdAt: new Date(),
    }),
  );
}

/**
 * The moderation history for one target, newest first.
 *
 * The composite index this needs (targetType + targetId + createdAt) is the
 * SQL `@@index([targetType, targetId])` carried over; Firestore requires it to
 * be declared, so it lives in firebase/firestore.indexes.json.
 */
export async function moderationHistory(
  targetType: string,
  targetId: string,
  take = 50,
): Promise<ModerationActionRecord[]> {
  const snap = await actions()
    .where('targetType', '==', targetType)
    .where('targetId', '==', targetId)
    .orderBy('createdAt', 'desc')
    .limit(take)
    .get();
  return docsToObjects<ModerationActionRecord>(snap.docs) as ModerationActionRecord[];
}
