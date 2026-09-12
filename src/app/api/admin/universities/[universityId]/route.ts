import { NextResponse, type NextRequest } from 'next/server';
import {
  findUniversityById,
  updateUniversity,
} from '@/lib/firebase/repositories/reference';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminUniversityUpdateSchema } from '@/server/validators/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/admin/universities/:universityId
 *
 * Names, city, email domains and the active flag are editable. `code` is not,
 * and is absent from the schema rather than rejected here: the register route
 * resolves the submitted value against `code`, and verification compares a
 * student card against it, so changing one would orphan every account attached
 * to that institution. Deactivating and creating a replacement is the safe
 * equivalent, and it leaves the existing accounts intact.
 *
 * There is no DELETE, and the reason has grown STRONGER rather than weaker.
 * Under Postgres, `User.universityId` was onDelete: SetNull, so removing a row
 * detached every student from their institution - bad, but at least defined.
 * Firestore has no referential actions at all: deleting the document would
 * leave every user pointing at an id that resolves to nothing, and the join is
 * done in application code that would render a blank affiliation without ever
 * noticing. Verified accounts, whose verification was granted against that
 * very affiliation, would be the worst affected.
 * `isActive: false` is the reversible form of the same intent: it drops the
 * institution out of registration (the register route filters on isActive)
 * while leaving history readable.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ universityId: string }> },
) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const { universityId } = await params;
    const parsed = adminUniversityUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    if (Object.keys(parsed.data).length === 0) {
      return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    }

    const existing = await findUniversityById(universityId);
    if (!existing) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }

    await updateUniversity(universityId, parsed.data);

    /**
     * Re-read rather than merging the patch locally.
     *
     * Prisma's `update` returned the stored row, so `after` described what the
     * database actually holds. Firestore's `update` returns only a write time,
     * and constructing `after` from the request body would record what was
     * ASKED FOR - which is not the same claim, and an audit entry that
     * describes an intention as if it were an outcome is worse than none.
     */
    const updated = (await findUniversityById(universityId)) ?? existing;

    // Only the fields that actually changed are recorded. Writing the whole
    // row into `before`/`after` would copy institution data into the audit log
    // on every no-op edit and make a real change harder to spot in the diff.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(parsed.data) as (keyof typeof parsed.data)[]) {
      const previous = (existing as Record<string, unknown>)[key];
      const next = (updated as Record<string, unknown>)[key];
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        before[key] = previous;
        after[key] = next;
      }
    }

    if (Object.keys(after).length > 0) {
      await adminAudit({
        actorId: actor.id,
        action: 'ADMIN_UNIVERSITY_UPDATED',
        entityType: 'university',
        entityId: universityId,
        before,
        after,
        request,
      });
    }

    return NextResponse.json({
      university: {
        id: updated.id,
        code: updated.code,
        nameAz: updated.nameAz,
        nameEn: updated.nameEn,
        nameRu: updated.nameRu,
        city: updated.city,
        emailDomains: updated.emailDomains,
        isActive: updated.isActive,
      },
    });
  });
}
