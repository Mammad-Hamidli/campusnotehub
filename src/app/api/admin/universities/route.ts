import { NextResponse, type NextRequest } from 'next/server';
import {
  countFaculties,
  createUniversity,
  listUniversities,
  universityCodeTaken,
} from '@/lib/firebase/repositories/reference';
import { countUsers } from '@/lib/firebase/repositories/users';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminUniversityCreateSchema } from '@/server/validators/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/universities - the institution list with live user counts.
 *
 * ---------------------------------------------------------------------------
 * THE COUNTS ARE NOW TWO AGGREGATIONS PER INSTITUTION
 * ---------------------------------------------------------------------------
 * `_count` was a join Prisma folded into the same query, so this was one round
 * trip regardless of how many institutions existed. Firestore cannot join, and
 * count() is billed per index entry rather than per document - so each figure
 * is its own aggregation, issued concurrently across the whole list.
 *
 * That is affordable precisely because this list is SMALL and bounded: it is
 * the set of institutions the platform recognises, a few dozen rows that grow
 * by hand. The same pattern over a user-sized collection would be wrong.
 *
 * Soft-deleted accounts are excluded from the user count for the same reason
 * the dashboard excludes them: a university's "users" figure that includes
 * deleted accounts is not a number anyone can act on.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    // Inactive institutions included: this is the screen where an operator
    // reactivates one, so hiding them would hide the thing being managed.
    const rows = await listUniversities(true);

    const counted = await Promise.all(
      rows.map(async (u) => {
        const [users, faculties] = await Promise.all([
          countUsers({ universityId: u.id, deletedAt: null }),
          countFaculties(u.id),
        ]);
        return {
          id: u.id,
          code: u.code,
          nameAz: u.nameAz,
          nameEn: u.nameEn,
          nameRu: u.nameRu,
          city: u.city,
          emailDomains: u.emailDomains,
          isActive: u.isActive,
          createdAt: u.createdAt,
          _count: { users, faculties },
        };
      }),
    );

    // Active first, then by code - the ordering the SQL `orderBy` gave.
    counted.sort(
      (a, b) => Number(b.isActive) - Number(a.isActive) || a.code.localeCompare(b.code),
    );

    return NextResponse.json(
      { universities: counted },
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

    /**
     * The duplicate-code check is now EXPLICIT, and that is a real change.
     *
     * `code` carried a UNIQUE constraint, so the old code could simply attempt
     * the insert and map Prisma's P2002 to a 409. Firestore has no unique
     * index on a field, so the collision has to be looked for before the write
     * - which makes this a check-then-act, and a second operator creating the
     * same code in the same instant could still slip through.
     *
     * That race is accepted here rather than engineered away: this endpoint is
     * ADMIN-only, institutions are added by hand a few times a year, and the
     * failure is a duplicate row an operator can see and delete. Making it
     * structural would mean keying the document by the code, which would make
     * a rename impossible - a worse trade for the actual usage.
     */
    if (await universityCodeTaken(input.code)) {
      return NextResponse.json({ error: 'admin.universities.errors.codeTaken' }, { status: 409 });
    }

    const created = await createUniversity(input);

    await adminAudit({
      actorId: actor.id,
      action: 'ADMIN_UNIVERSITY_CREATED',
      entityType: 'university',
      entityId: created.id,
      after: { code: created.code, nameEn: created.nameEn, isActive: created.isActive },
      request,
    });

    return NextResponse.json(
      {
        university: {
          id: created.id,
          code: created.code,
          nameEn: created.nameEn,
          isActive: created.isActive,
        },
      },
      { status: 201 },
    );
  });
}
