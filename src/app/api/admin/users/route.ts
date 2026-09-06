import { NextResponse, type NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
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
 * The `select` below is an allow-list, not an omission list, and that is the
 * whole point. `passwordHash`, `emailHash` and `phoneHash` live on the same
 * model; a `select` that enumerates what it wants cannot leak them, whereas an
 * omit-list silently starts leaking the next sensitive column somebody adds.
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

    const where: Prisma.UserWhereInput = {};
    if (!input.includeDeleted) where.deletedAt = null;
    if (input.role) where.role = input.role;
    if (input.accountStatus) where.accountStatus = input.accountStatus;
    if (input.verificationStatus) where.verificationStatus = input.verificationStatus;
    if (input.universityId) where.universityId = input.universityId;

    if (input.createdFrom || input.createdTo) {
      where.createdAt = {};
      if (input.createdFrom) where.createdAt.gte = input.createdFrom;
      // A date-only `to` means "through the end of that day". Without this a
      // range of 01→01 returns nothing, which reads as a broken filter.
      if (input.createdTo) {
        const to = new Date(input.createdTo);
        if (to.getHours() === 0 && to.getMinutes() === 0 && to.getSeconds() === 0) {
          to.setHours(23, 59, 59, 999);
        }
        where.createdAt.lte = to;
      }
    }

    if (input.q) {
      // Searchable fields only: readable identity columns the admin already
      // sees in the table. Searching a hash column would let a caller confirm
      // whether a given address exists without ever being shown it.
      where.OR = [
        { fullName: { contains: input.q, mode: 'insensitive' } },
        { nickname: { contains: input.q, mode: 'insensitive' } },
        { email: { contains: input.q, mode: 'insensitive' } },
        { id: input.q },
      ];
    }

    // `sort` is a z.enum, so this cannot become an arbitrary column name.
    // Secondary id sort keeps pagination stable when the primary key ties -
    // otherwise rows shuffle between pages and records get skipped.
    const orderBy: Prisma.UserOrderByWithRelationInput[] = [
      { [input.sort]: input.order } as Prisma.UserOrderByWithRelationInput,
      { id: 'asc' },
    ];

    const [total, rows] = await db.$transaction([
      db.user.count({ where }),
      db.user.findMany({
        where,
        orderBy,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        select: {
          id: true,
          fullName: true,
          nickname: true,
          email: true,
          phone: true,
          role: true,
          accountStatus: true,
          verificationStatus: true,
          isVerified: true,
          graduationYear: true,
          graduationMonth: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
          deletedAt: true,
          frozenUntil: true,
          frozenReason: true,
          frozenAt: true,
          facultySlug: true,
          facultyOther: true,
          university: { select: { id: true, code: true, nameEn: true } },
          faculty: { select: { id: true, nameEn: true } },
        },
      }),
    ]);

    return NextResponse.json(
      {
        users: rows.map((u) => ({
          ...u,
          phone: maskPhone(u.phone),
          // Same serialiser the detail modal and /api/me use, so the row badge
          // and the modal can never disagree about whether an account is
          // frozen - which is how a stale badge outlives the freeze itself.
          freeze: freezeState(u),
          facultyLabel: facultyLabel(u.facultySlug, u.facultyOther) ?? u.faculty?.nameEn ?? null,
        })),
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
