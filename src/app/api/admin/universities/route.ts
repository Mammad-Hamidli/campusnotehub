import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminUniversityCreateSchema } from '@/server/validators/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/universities - the institution list with live user counts.
 *
 * `_count` is a join Prisma does in the same query, not a per-row follow-up, so
 * this stays one round trip regardless of how many institutions exist.
 * Soft-deleted accounts are excluded from the count for the same reason the
 * dashboard excludes them: a university's "users" figure that includes deleted
 * accounts is not a number anyone can act on.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const rows = await db.university.findMany({
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        nameAz: true,
        nameEn: true,
        nameRu: true,
        city: true,
        emailDomains: true,
        isActive: true,
        createdAt: true,
        _count: { select: { users: { where: { deletedAt: null } }, faculties: true } },
      },
    });

    return NextResponse.json(
      { universities: rows },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}

/**
 * POST /api/admin/universities - add an institution.
 *
 * ADMIN only. A new university immediately becomes selectable at registration
 * and becomes something the verifier compares a student card against, so this
 * is a change to the trust model rather than a content edit.
 *
 * NOTE for whoever adds the next institution: the registration dropdown is
 * still built from the static list in src/lib/universities.ts, and the
 * register route resolves the submitted code against the database. A row
 * created here is therefore usable by the API but will not appear in the
 * signup dropdown until that file is replaced by a fetch - the file's own
 * header flags this as the intended follow-up. Creating a row here is safe;
 * it is just not the whole job, and the panel says so in the UI.
 */
export async function POST(request: NextRequest) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const parsed = adminUniversityCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const input = parsed.data;

    try {
      const created = await db.university.create({
        data: input,
        select: { id: true, code: true, nameEn: true, isActive: true },
      });

      await adminAudit({
        actorId: actor.id,
        action: 'ADMIN_UNIVERSITY_CREATED',
        entityType: 'university',
        entityId: created.id,
        after: { code: created.code, nameEn: created.nameEn, isActive: created.isActive },
        request,
      });

      return NextResponse.json({ university: created }, { status: 201 });
    } catch (error) {
      // `code` is unique. A duplicate is a user error, not a server fault.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return NextResponse.json({ error: 'admin.universities.errors.codeTaken' }, { status: 409 });
      }
      throw error;
    }
  });
}
