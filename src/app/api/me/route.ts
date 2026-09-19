import { NextResponse, type NextRequest } from 'next/server';
import { FieldVisibility, Locale } from '@/lib/enums';
import { z } from 'zod';
import {
  findUserById,
  profileCounts,
  updateUser,
  type UserRecord,
} from '@/lib/firebase/repositories/users';
import {
  findFacultyById,
  findUniversityById,
} from '@/lib/firebase/repositories/reference';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { creatorStatsFor } from '@/lib/firebase/repositories/notes';
import { findMentorByUserId } from '@/lib/firebase/repositories/mentors';
import { sendEmailAsync } from '@/lib/email/send';
import { freezeState } from '@/lib/auth/freeze';
import { FACULTY_OTHER, facultyLabel, isFacultySlug } from '@/lib/faculties';

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
/**
 * The allow-list, now enforced in code rather than by the query.
 *
 * ===========================================================================
 * THIS IS A SECURITY CONTROL, NOT A FORMATTING STEP
 * ===========================================================================
 * Under Prisma the `select` clause did two jobs at once: it said what to fetch
 * AND what to return, so a field that was never selected could not reach the
 * response even by accident. Firestore has no projection - `get()` returns the
 * WHOLE document - so half of that guarantee disappeared in the move, and the
 * obvious `...user` spread would have published every field on the record.
 *
 * The list below restores it. It is the same set the old `select` named, and
 * it is an allow-list for the same reason: a field added to the user model
 * later stays invisible here until somebody adds it deliberately.
 *
 * The credential fields this used to guard against - passwordHash, emailHash,
 * phoneHash - are no longer on the user document at all; they live in
 * `credentials/{userId}`, which this route never reads. That makes the leak
 * structurally impossible rather than merely prevented. The projection stays
 * anyway: it is what keeps internal columns like failedLoginCount, lockedUntil
 * and nicknameLower out of a response, and defence in depth on the endpoint
 * that returns a user's own email and phone is worth the few lines.
 */
function selfProjection(user: UserRecord) {
  return {
    id: user.id,
    fullName: user.fullName,
    nickname: user.nickname,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    headline: user.headline,
    bio: user.bio,
    locale: user.locale,
    timezone: user.timezone,
    role: user.role,
    accountStatus: user.accountStatus,
    frozenUntil: user.frozenUntil,
    frozenReason: user.frozenReason,
    frozenAt: user.frozenAt,
    facultySlug: user.facultySlug,
    facultyOther: user.facultyOther,
    verificationStatus: user.verificationStatus,
    isVerified: user.isVerified,
    verifiedAt: user.verifiedAt,
    graduationYear: user.graduationYear,
    graduationMonth: user.graduationMonth,
    emailVerifiedAt: user.emailVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    showRealName: user.showRealName,
    showEmail: user.showEmail,
    showPhone: user.showPhone,
    showUniversity: user.showUniversity,
    showFaculty: user.showFaculty,
    showGraduationYear: user.showGraduationYear,
  };
}

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

  const user = await findUserById(userId);

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

  /**
   * The relations and the counts, fetched alongside rather than joined.
   *
   * Firestore has no joins, so what Prisma expressed as nested `select`s
   * becomes explicit reads. They run concurrently because none depends on
   * another, so this costs one round trip's latency rather than three.
   * `university` and `faculty` are null when unset, exactly as the relation
   * was - the response shape the client already parses does not change.
   */
  const [university, faculty, counts, stats, mentor] = await Promise.all([
    user.universityId ? findUniversityById(user.universityId) : null,
    user.facultyId ? findFacultyById(user.facultyId) : null,
    profileCounts(userId),
    creatorStatsFor([userId]),
    findMentorByUserId(userId),
  ]);

  return NextResponse.json(
    {
      user: {
        ...selfProjection(user),
        university: university
          ? {
              id: university.id,
              code: university.code,
              nameAz: university.nameAz,
              nameEn: university.nameEn,
              nameRu: university.nameRu,
              city: university.city,
            }
          : null,
        faculty: faculty
          ? {
              id: faculty.id,
              nameAz: faculty.nameAz,
              nameEn: faculty.nameEn,
              nameRu: faculty.nameRu,
            }
          : null,
        _count: counts,
        initials,
        /** `@handle avg⭐ (X files for Y total reviews)` inputs. */
        creatorStats: stats.get(userId) ?? null,
        /** Approved mentor profile exists: drives the schedule-settings link. */
        isMentor: Boolean(mentor?.isApproved),
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
      .refine(isFacultySlug, 'errors.validationFailed')
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
  const data: Record<string, unknown> = {};

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

  await updateUser(userId, data);

  /**
   * Read back rather than echoing the patch.
   *
   * Prisma's update returned the stored row, so the response was necessarily
   * the truth. A Firestore update returns nothing, and echoing `data` back
   * would report what we ASKED for - which diverges silently the moment a
   * value is normalised on the way in. The extra read keeps the old guarantee
   * that the client is told the state that actually persisted.
   */
  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  }

  sendEmailAsync(user.email, 'profileUpdated', {
    nickname: user.nickname,
    fields: Object.keys(data).filter((key) => key !== 'facultyOther'),
  });

  // Narrowed to the editable set - the same fields the old `select` returned.
  return NextResponse.json(
    {
      user: {
        id: user.id,
        fullName: user.fullName,
        nickname: user.nickname,
        headline: user.headline,
        bio: user.bio,
        locale: user.locale,
        timezone: user.timezone,
        facultySlug: user.facultySlug,
        facultyOther: user.facultyOther,
        showRealName: user.showRealName,
        showEmail: user.showEmail,
        showPhone: user.showPhone,
        showUniversity: user.showUniversity,
        showFaculty: user.showFaculty,
        showGraduationYear: user.showGraduationYear,
        facultyLabel: facultyLabel(user.facultySlug, user.facultyOther),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
