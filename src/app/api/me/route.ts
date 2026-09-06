import { NextResponse, type NextRequest } from 'next/server';
import { FieldVisibility, Locale, Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { freezeState } from '@/lib/auth/freeze';
import { FACULTIES, FACULTY_OTHER, facultyLabel } from '@/lib/faculties';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me - the signed-in viewer.
 *
 * This did not exist, which is why every screen in the product rendered a
 * hardcoded identity: the dashboard shell carried a literal `mammad_h`, the
 * settings form carried a literal `aysel_m`, and neither could ever show the
 * person actually signed in. Those placeholders were not a styling choice,
 * they were a missing endpoint.
 *
 * The select is an allow-list. This is the viewer's OWN record, so email and
 * phone are theirs to see - but passwordHash, emailHash and phoneHash are on
 * the same model and naming what we want is what keeps them out as the model
 * grows.
 */
export async function GET(request: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      fullName: true,
      nickname: true,
      email: true,
      phone: true,
      avatarUrl: true,
      headline: true,
      bio: true,
      locale: true,
      timezone: true,
      role: true,
      accountStatus: true,
      frozenUntil: true,
      frozenReason: true,
      frozenAt: true,
      facultySlug: true,
      facultyOther: true,
      verificationStatus: true,
      isVerified: true,
      verifiedAt: true,
      graduationYear: true,
      graduationMonth: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      createdAt: true,
      showRealName: true,
      showEmail: true,
      showPhone: true,
      showUniversity: true,
      showFaculty: true,
      showGraduationYear: true,
      university: { select: { id: true, code: true, nameAz: true, nameEn: true, nameRu: true, city: true } },
      faculty: { select: { id: true, nameAz: true, nameEn: true, nameRu: true } },
      _count: { select: { posts: true, notes: true, followers: true, following: true } },
    },
  });

  if (!user) {
    // requireSession already rejects deleted and banned accounts, so reaching
    // here means the row vanished between the two queries.
    return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  }

  /**
   * Initials for the avatar fallback, computed here so every surface that
   * renders an avatar agrees. Derived from the NICKNAME, never the legal name -
   * no shared surface in this product displays the name that has to match an
   * identity document.
   */
  const initials = user.nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';

  return NextResponse.json(
    {
      user: {
        ...user,
        initials,
        /**
         * The resolved faculty label, so no consumer has to re-implement the
         * "catalogue slug, or the typed value when it is `other`" rule. Null
         * when nothing has been chosen - the caller decides how that reads.
         */
        facultyLabel: facultyLabel(user.facultySlug, user.facultyOther),
        // Same serialiser the admin panel uses, so the account holder and the
        // operator looking at them cannot see different freeze states.
        freeze: freezeState(user),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * PATCH /api/me - the viewer edits their own account.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT EDITABLE HERE
 * ---------------------------------------------------------------------------
 * `role`, `accountStatus`, `verificationStatus`, `isVerified`, `email` and
 * `phone` are absent from the schema below, and their absence is the security
 * control. A self-service endpoint that accepted `role` would be a one-line
 * privilege escalation, and it is exactly the shape of bug that hides in a
 * handler written as `data: body`. Naming the permitted fields means a new
 * column on the model is not silently editable by whoever finds this route.
 *
 * `email` and `phone` are excluded for a different reason: both have HMAC
 * companion columns (emailHash, phoneHash) that are unique and are documented
 * as surviving account deletion so a banned identity cannot be recycled.
 * Changing one without the other would corrupt that pairing, so address
 * changes need their own verified flow rather than a field on a settings form.
 *
 * This one endpoint serves students and administrators alike. There is no
 * separate admin profile route, because an admin editing their OWN headline is
 * not an administrative act - it is the same operation, and giving it a second
 * implementation would mean two places to keep the allow-list correct.
 */
const patchSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[\p{L}\s'-]+$/u, 'errors.validationFailed')
      .optional(),
    headline: z.string().trim().max(160).optional(),
    bio: z.string().trim().max(1000).optional(),
    locale: z.nativeEnum(Locale).optional(),
    timezone: z.string().trim().max(64).optional(),
    facultySlug: z
      .string()
      .trim()
      .refine((v) => FACULTIES.some((f) => f.slug === v), 'errors.validationFailed')
      .optional(),
    /** Only meaningful with facultySlug === 'other'; enforced below and by a CHECK. */
    facultyOther: z.string().trim().max(120).optional(),
    showRealName: z.nativeEnum(FieldVisibility).optional(),
    showEmail: z.nativeEnum(FieldVisibility).optional(),
    showPhone: z.nativeEnum(FieldVisibility).optional(),
    showUniversity: z.nativeEnum(FieldVisibility).optional(),
    showFaculty: z.nativeEnum(FieldVisibility).optional(),
    showGraduationYear: z.nativeEnum(FieldVisibility).optional(),
  })
  .refine(
    (d) => d.facultySlug !== FACULTY_OTHER || Boolean(d.facultyOther?.trim()),
    { path: ['facultyOther'], message: 'auth.errors.facultyOtherRequired' },
  );

export async function PATCH(request: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const data: Prisma.UserUpdateInput = {};

  if (input.fullName !== undefined) data.fullName = input.fullName;
  // An emptied optional text field means "clear it", which is null in the
  // database rather than an empty string - otherwise `headline: ''` renders as
  // a blank line where the UI expected nothing at all.
  if (input.headline !== undefined) data.headline = input.headline || null;
  if (input.bio !== undefined) data.bio = input.bio || null;
  if (input.locale !== undefined) data.locale = input.locale;
  if (input.timezone !== undefined) data.timezone = input.timezone;

  if (input.facultySlug !== undefined) {
    data.facultySlug = input.facultySlug;
    // The free-text column is cleared whenever the choice is not 'other'. The
    // CHECK constraint added in the migration refuses the inconsistent pair,
    // so failing to do this would turn a stale value into a 500.
    data.facultyOther = input.facultySlug === FACULTY_OTHER ? (input.facultyOther ?? null) : null;
  }

  for (const key of [
    'showRealName',
    'showEmail',
    'showPhone',
    'showUniversity',
    'showFaculty',
    'showGraduationYear',
  ] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const user = await db.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      fullName: true,
      nickname: true,
      headline: true,
      bio: true,
      locale: true,
      timezone: true,
      facultySlug: true,
      facultyOther: true,
      showRealName: true,
      showEmail: true,
      showPhone: true,
      showUniversity: true,
      showFaculty: true,
      showGraduationYear: true,
    },
  });

  return NextResponse.json(
    { user: { ...user, facultyLabel: facultyLabel(user.facultySlug, user.facultyOther) } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
