import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docsToObjects, forFirestore } from '../convert';

/**
 * The audit log.
 *
 * ---------------------------------------------------------------------------
 * APPEND-ONLY IS NOW A CONVENTION, NOT A GUARANTEE
 * ---------------------------------------------------------------------------
 * This is the single most important thing lost in the move from Postgres, and
 * it should not be discovered later by surprise.
 *
 * Under Postgres, `0001_invariants.sql` REVOKED update and delete on
 * audit_logs from the application role. The database itself refused to rewrite
 * history, so "the audit log is append-only" was a property of the system
 * rather than a promise made by the code.
 *
 * Firestore has no per-collection grants for the Admin SDK - a service account
 * can write anything. The security rules deny clients completely (see
 * firestore.rules), so no BROWSER can touch these rows, but a bug or a
 * malicious change in server code could. What replaces the grant:
 *
 *   1. This module exposes no update and no delete. There is one writer,
 *      `writeAuditLog`, and it only ever creates.
 *   2. Every write stamps `createdAt` server-side rather than accepting one,
 *      so a caller cannot backdate an entry.
 *
 * If the append-only property must be enforced rather than conventional, the
 * options are a Firestore trigger that rejects updates, or exporting to a
 * write-once sink such as BigQuery with an append-only table. Both are
 * deployment work outside this migration, and neither should be assumed to be
 * in place.
 */

export type AuditRecord = {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  deviceFingerprint: string | null;
  userAgent: string | null;
  ip: string | null;
  result: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
};

const logs = () => adminDb().collection(COLLECTIONS.auditLogs);

/** The ONLY writer. Creates; never updates. */
export async function writeAuditLog(entry: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  deviceFingerprint?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  result?: string | null;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await logs().add(
    forFirestore({
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      deviceFingerprint: entry.deviceFingerprint ?? null,
      userAgent: entry.userAgent ?? null,
      ip: entry.ip ?? null,
      result: entry.result ?? 'SUCCESS',
      before: entry.before ?? null,
      after: entry.after ?? null,
      // Stamped here, not accepted from the caller: an audit entry that can be
      // backdated is not an audit entry.
      createdAt: new Date(),
    }),
  );
}

export type AuditFilter = {
  q?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  createdFrom?: Date;
  createdTo?: Date;
};

/**
 * Reads the log for the admin table and the Excel export.
 *
 * The date range is pushed into the query because `createdAt` is the sort key
 * and Firestore can range-filter the field it orders by. Everything else -
 * the free-text match across action, entity and actor - is applied afterwards,
 * because Firestore has no OR across fields and no substring search.
 *
 * The scan ceiling bounds that: the query never materialises more than this,
 * so an unfiltered log of a million rows cannot be pulled into memory. When
 * the ceiling is hit the caller is told, so a truncated view is never mistaken
 * for a complete one.
 */
const SCAN_CEILING = 5000;

export async function listAuditLogs(
  filter: AuditFilter,
  limit: number,
): Promise<{ rows: AuditRecord[]; truncated: boolean }> {
  let query: FirebaseFirestore.Query = logs();

  if (filter.actorId) query = query.where('actorId', '==', filter.actorId);
  if (filter.entityType) query = query.where('entityType', '==', filter.entityType);
  if (filter.entityId) query = query.where('entityId', '==', filter.entityId);
  if (filter.createdFrom) query = query.where('createdAt', '>=', filter.createdFrom);
  if (filter.createdTo) query = query.where('createdAt', '<=', filter.createdTo);

  const snap = await query.orderBy('createdAt', 'desc').limit(Math.min(limit, SCAN_CEILING)).get();
  let rows = docsToObjects<AuditRecord>(snap.docs) as AuditRecord[];

  if (filter.action) {
    const needle = filter.action.toLowerCase();
    rows = rows.filter((r) => r.action.toLowerCase().includes(needle));
  }
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.action.toLowerCase().includes(needle) ||
        r.entityType.toLowerCase().includes(needle) ||
        r.entityId === filter.q,
    );
  }

  return { rows, truncated: snap.size >= Math.min(limit, SCAN_CEILING) };
}

export async function countAuditLogs(): Promise<number> {
  const snap = await logs().count().get();
  return snap.data().count;
}

/** Recent entries about one entity, for the admin user detail view. */
export async function auditForEntity(
  entityType: string,
  entityId: string,
  take = 50,
): Promise<AuditRecord[]> {
  const snap = await logs()
    .where('entityType', '==', entityType)
    .where('entityId', '==', entityId)
    .orderBy('createdAt', 'desc')
    .limit(take)
    .get();
  return docsToObjects<AuditRecord>(snap.docs) as AuditRecord[];
}
