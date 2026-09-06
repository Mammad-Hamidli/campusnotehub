import type { Prisma } from '@prisma/client';
import type { adminAuditListSchema } from '@/server/validators/admin';

/**
 * The filter, as a reusable fragment.
 *
 * Exported because the Excel export at ./export must apply EXACTLY the same
 * filters as the screen it was launched from. Re-implementing the predicate
 * there is how an export silently disagrees with the table above it, and an
 * audit export that does not match what the operator was looking at is worse
 * than no export.
 */
export function auditWhere(
  input: ReturnType<(typeof adminAuditListSchema)['parse']>,
): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (input.action) where.action = { contains: input.action, mode: 'insensitive' };
  if (input.entityType) where.entityType = input.entityType;
  if (input.entityId) where.entityId = input.entityId;
  if (input.actorId) where.actorId = input.actorId;

  if (input.createdFrom || input.createdTo) {
    where.createdAt = {};
    if (input.createdFrom) where.createdAt.gte = input.createdFrom;
    if (input.createdTo) {
      const to = new Date(input.createdTo);
      // A bare `?createdTo=2026-09-06` means "through the end of that day".
      // Without this, filtering to a single day returns nothing, because
      // midnight excludes every row actually written during it.
      if (to.getHours() === 0 && to.getMinutes() === 0 && to.getSeconds() === 0) {
        to.setHours(23, 59, 59, 999);
      }
      where.createdAt.lte = to;
    }
  }

  if (input.q) {
    where.OR = [
      { action: { contains: input.q, mode: 'insensitive' } },
      { entityType: { contains: input.q, mode: 'insensitive' } },
      { entityId: input.q },
      { actor: { nickname: { contains: input.q, mode: 'insensitive' } } },
    ];
  }

  return where;
}
