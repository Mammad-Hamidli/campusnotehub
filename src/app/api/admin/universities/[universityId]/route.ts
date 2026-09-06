import { NextResponse, type NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
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
 * There is no DELETE. `User.universityId` is onDelete: SetNull, so removing a
 * row would silently detach every student from their institution - including
 * verified ones, whose verification was granted against that very affiliation.
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

    const existing = await db.university.findUnique({
      where: { id: universityId },
      select: { id: true, code: true, nameEn: true, city: true, emailDomains: true, isActive: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }

    const updated = await db.university.update({
      where: { id: universityId },
      data: parsed.data,
      select: {
        id: true,
        code: true,
        nameAz: true,
        nameEn: true,
        nameRu: true,
        city: true,
        emailDomains: true,
        isActive: true,
      },
    });

    // Only the fields that actually changed are recorded. Writing the whole row
    // into `before`/`after` would copy institution data into the audit table on
    // every no-op edit and make a real change harder to spot in the diff.
    const before: Record<string, Prisma.InputJsonValue> = {};
    const after: Record<string, Prisma.InputJsonValue> = {};
    for (const key of Object.keys(parsed.data) as (keyof typeof parsed.data)[]) {
      const previous = (existing as Record<string, Prisma.InputJsonValue>)[key];
      const next = (updated as Record<string, Prisma.InputJsonValue>)[key];
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

    return NextResponse.json({ university: updated });
  });
}
