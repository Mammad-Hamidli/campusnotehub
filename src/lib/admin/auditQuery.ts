import type { AuditFilter } from '@/lib/firebase/repositories/audit';
import type { adminAuditListSchema } from '@/server/validators/admin';

/**
 * The filter, as a reusable fragment.
 *
 * Exported because the Excel export at ./export must apply EXACTLY the same
 * filters as the screen it was launched from. Re-implementing the predicate
 * there is how an export silently disagrees with the table above it, and an
 * audit export that does not match what the operator was looking at is worse
 * than no export.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS USED TO BE, AND WHY IT IS NOW PLAIN DATA
 * ---------------------------------------------------------------------------
 * It built a `Prisma.AuditLogWhereInput` - a query fragment the ORM composed
 * into SQL. Firestore has no equivalent object, and the query it CAN serve is
 * different in kind: equality filters and one range, with the free-text match
 * applied afterwards.
 *
 * So this now returns a plain, declarative AuditFilter and listAuditLogs()
 * decides which parts become a Firestore query and which are applied to the
 * result. That split is documented where it happens rather than here, because
 * this function's only job - "both screens filter identically" - is unchanged.
 *
 * The `actor.nickname` clause of the old free-text search is deliberately
 * absent: it was a join predicate, and Firestore cannot filter a document by a
 * field of another one. Searching by operator is served by the `actorId`
 * filter, which the UI populates from the actor picker.
 */
export function auditWhere(
  input: ReturnType<(typeof adminAuditListSchema)['parse']>,
): AuditFilter {
  const filter: AuditFilter = {};
  if (input.action) filter.action = input.action;
  if (input.entityType) filter.entityType = input.entityType;
  if (input.entityId) filter.entityId = input.entityId;
  if (input.actorId) filter.actorId = input.actorId;
  if (input.q) filter.q = input.q;

  if (input.createdFrom) filter.createdFrom = input.createdFrom;
  if (input.createdTo) {
    const to = new Date(input.createdTo);
    // A bare `?createdTo=2026-09-06` means "through the end of that day".
    // Without this, filtering to a single day returns nothing, because
    // midnight excludes every row actually written during it.
    if (to.getHours() === 0 && to.getMinutes() === 0 && to.getSeconds() === 0) {
      to.setHours(23, 59, 59, 999);
    }
    filter.createdTo = to;
  }

  return filter;
}
