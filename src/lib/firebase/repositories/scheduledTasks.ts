import type { Transaction } from 'firebase-admin/firestore';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docsToObjects, forFirestore, sortBy } from '../convert';

/**
 * Deferred work: escrow releases and booking reminders.
 *
 * ---------------------------------------------------------------------------
 * THE DEDUPE KEY IS THE DOCUMENT ID
 * ---------------------------------------------------------------------------
 * `scheduled_tasks.dedupeKey` carried a UNIQUE constraint whose whole job was
 * to stop the same work being queued twice - scheduling "release the escrow on
 * order X" a second time would pay a seller twice. Firestore has no unique
 * index, so the key becomes the document id and a duplicate schedule collides
 * on `create()` instead of being rejected by a constraint.
 *
 * That matters more here than almost anywhere else in the migration, because
 * this table is written from INSIDE the purchase transaction: if a retried
 * purchase could append a second ESCROW_RELEASE row, the idempotency the order
 * id gives us would be undone one collection over.
 */

export type ScheduledTaskRecord = {
  id: string;
  kind: string;
  runAt: Date;
  payload: Record<string, unknown> | null;
  dedupeKey: string;
  executedAt: Date | null;
  attempts: number;
  lastError: string | null;
};

const tasks = () => adminDb().collection(COLLECTIONS.scheduledTasks);

function taskId(dedupeKey: string): string {
  return dedupeKey.replace(/\//g, '_');
}

/**
 * Queues work inside an existing Firestore transaction.
 *
 * `create` rather than `set`, so a re-run of the surrounding transaction
 * cannot schedule the same payout twice. The caller is expected to be in the
 * WRITE phase already - this issues no reads, so it is safe to call at any
 * point after the transaction's last read.
 */
export function scheduleTx(
  tx: Transaction,
  params: { kind: string; runAt: Date; dedupeKey: string; payload?: Record<string, unknown> },
): void {
  tx.create(
    tasks().doc(taskId(params.dedupeKey)),
    forFirestore({
      kind: params.kind,
      runAt: params.runAt,
      dedupeKey: params.dedupeKey,
      payload: params.payload ?? null,
      executedAt: null,
      attempts: 0,
      lastError: null,
    }),
  );
}

/** Standalone scheduling, for callers that are not already in a transaction. */
export async function schedule(params: {
  kind: string;
  runAt: Date;
  dedupeKey: string;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    await tasks()
      .doc(taskId(params.dedupeKey))
      .create(
        forFirestore({
          kind: params.kind,
          runAt: params.runAt,
          dedupeKey: params.dedupeKey,
          payload: params.payload ?? null,
          executedAt: null,
          attempts: 0,
          lastError: null,
        }),
      );
    return true;
  } catch (error) {
    // 6 = ALREADY_EXISTS, which means the work is already queued. That is the
    // postcondition the caller wanted, so it is success, not a failure.
    if ((error as { code?: number }).code === 6) return false;
    throw error;
  }
}

/**
 * Tasks that are due.
 *
 * `executedAt == null` and `runAt <= now` is an equality plus an inequality on
 * two different fields, which Firestore serves happily (only ONE field may
 * carry a range). The composite index for it is declared in
 * firebase/firestore.indexes.json.
 */
export async function dueTasks(now: Date, take = 100): Promise<ScheduledTaskRecord[]> {
  const snap = await tasks()
    .where('executedAt', '==', null)
    .where('runAt', '<=', now)
    .limit(take)
    .get();
  return sortBy(docsToObjects<ScheduledTaskRecord>(snap.docs) as ScheduledTaskRecord[], 'runAt');
}

export async function markExecuted(id: string): Promise<void> {
  await tasks().doc(id).update({ executedAt: new Date() });
}

/**
 * Records a failure without consuming the task.
 *
 * `executedAt` stays null on purpose so the next sweep picks it up again; the
 * attempt counter is what a human uses to spot work that will never succeed.
 * Silently marking a failed payout as done is the failure mode this avoids.
 */
export async function markFailed(id: string, message: string): Promise<void> {
  const { FieldValue } = await import('firebase-admin/firestore');
  await tasks()
    .doc(id)
    .update({ attempts: FieldValue.increment(1), lastError: message.slice(0, 1000) });
}
