import { NextResponse, type NextRequest } from 'next/server';
import { listUsers } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds, findFacultyById } from '@/lib/firebase/repositories/reference';
import { freezeState } from '@/lib/auth/freeze';
import { facultyLabel } from '@/lib/faculties';
import { withAdmin } from '@/lib/auth/admin';
import { adminUserListSchema } from '@/server/validators/admin';
import { maskPhone } from '@/lib/admin/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users - the users table.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENDPOINT WILL NOT RETURN
 * ---------------------------------------------------------------------------
 * The projection below is an allow-list, not an omission list, and that is the
 * whole point: enumerating what a response WANTS cannot leak a new sensitive
 * field, whereas an omit-list silently starts leaking the next one somebody
 * adds.
 *
 * That property is now doubly load-bearing. Under Postgres `passwordHash`,
 * `emailHash` and `phoneHash` were columns on the same table, and a `select`
 * was what kept them out. In Firestore they are not in the user document at
 * all - they live in a separate `credentials` collection that findUserById()
 * never reads (see the header of the users repository). So a leak here would
 * take two mistakes rather than one, and this allow-list is still the first.
 *
 * Phone numbers are MASKED here. FieldVisibility.PRIVATE is documented as
 * "the owner and platform moderators only", so staff are permitted to see one -
 * but a bulk listing is browsing, not investigation. The full number is on the
 * detail endpoint, where fetching it writes an audit row against a single named
 * account. That is the same shape as the KYC document rule: sensitive reads are
 * allowed, but never silently and never in bulk.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const parsed = adminUserListSchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const input = parsed.data;

    /**
     * The date-range upper bound.
     *
     * A date-only `to` means "through the end of that day". Without this a
     * range of 01 to 01 returns nothing, which reads as a broken filter.
     */
    let createdTo: Date | undefined;
    if (input.createdTo) {
      createdTo = new Date(input.createdTo);
      if (
        createdTo.getHours() === 0 &&
        createdTo.getMinutes() === 0 &&
        createdTo.getSeconds() === 0
      ) {
        createdTo.setHours(23, 59, 59, 999);
      }
    }

    /**
     * Filtering, sorting and paging all happen in listUsers().
     *
     * The free-text box matches fullName, nickname OR email simultaneously,
     * which is a cross-field `OR` that Firestore cannot express - so the
     * repository pushes the indexable equality filters into the query and
     * applies the text match to what comes back, under a scan ceiling. Its
     * header explains why that trade is right for an administrative table and
     * wrong for a user-facing feed.
     *
     * The searchable fields are unchanged and deliberately readable ones:
     * searching a hash field would let a caller confirm whether a given
     * address exists without ever being shown it.
     *
     * `sort` is a z.enum, so it cannot become an arbitrary field name.
     */
    const { users: rows, total } = await listUsers(
      {
        q: input.q,
        role: input.role,
        accountStatus: input.accountStatus,
        verificationStatus: input.verificationStatus,
        universityId: input.universityId,
        includeDeleted: input.includeDeleted,
        createdFrom: input.createdFrom ? new Date(input.createdFrom) : undefined,
        createdTo,
      },
      input.page,
      input.pageSize,
      input.sort,
      input.order,
    );

    // The university and faculty decorations Prisma resolved with joins. One
    // batched read for the universities; faculties are looked up individually
    // because only a handful of rows on a page carry one.
    const universities = await findUniversitiesByIds(
      rows.map((u) => u.universityId).filter((id): id is string => Boolean(id)),
    );
    const facultyIds = [...new Set(rows.map((u) => u.facultyId).filter(Boolean))] as string[];
    const faculties = new Map(
      (await Promise.all(facultyIds.map((id) => findFacultyById(id))))
        .filter((f) => f !== null)
        .map((f) => [f.id, f]),
    );

    return NextResponse.json(
      {
        users: rows.map((u) => {
          const university = u.universityId ? universities.get(u.universityId) : null;
          const faculty = u.facultyId ? faculties.get(u.facultyId) : null;
          return {
            id: u.id,
            fullName: u.fullName,
            nickname: u.nickname,
            email: u.email,
            // MASKED here. FieldVisibility.PRIVATE is documented as "the owner
            // and platform moderators only", so staff may see one - but a bulk
            // listing is browsing, not investigation. The full number is on
            // the detail endpoint, where fetching it writes an audit row
            // against a single named account.
            phone: maskPhone(u.phone),
            role: u.role,
            accountStatus: u.accountStatus,
            verificationStatus: u.verificationStatus,
            isVerified: u.isVerified,
            graduationYear: u.graduationYear,
            graduationMonth: u.graduationMonth,
            createdAt: u.createdAt,
            updatedAt: u.updatedAt,
            lastLoginAt: u.lastLoginAt,
            deletedAt: u.deletedAt,
            frozenUntil: u.frozenUntil,
            frozenReason: u.frozenReason,
            frozenAt: u.frozenAt,
            facultySlug: u.facultySlug,
            facultyOther: u.facultyOther,
            university: university
              ? { id: university.id, code: university.code, nameEn: university.nameEn }
              : null,
            faculty: faculty ? { id: faculty.id, nameEn: faculty.nameEn } : null,
            // Same serialiser the detail modal and /api/me use, so the row
            // badge and the modal can never disagree about whether an account
            // is frozen - which is how a stale badge outlives the freeze.
            freeze: freezeState(u),
            facultyLabel:
              facultyLabel(u.facultySlug, u.facultyOther) ?? faculty?.nameEn ?? null,
          };
        }),
        page: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
