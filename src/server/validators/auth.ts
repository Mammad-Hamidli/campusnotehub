import { z } from 'zod';
import { UserRole } from '@/lib/enums';
import { UNIVERSITIES } from '@/lib/universities';
import { FACULTY_OTHER, FACULTY_SLUGS } from '@/lib/faculties';
import { timezoneSchema, weeklyRulesSchema } from '@/lib/mentors/schedule';

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Accepted university values, taken from the same list that builds the
 * registration dropdown and seeds the table.
 *
 * The form submits the stable CODE ('ADA', 'BDU'), not the database cuid -
 * the cuid is generated at seed time and is never exposed to the client. This
 * used to be `z.string().cuid()`, which rejected every real submission before
 * the route could reach its duplicate handling. Matching against the known set
 * is strictly narrower than a cuid format check, not looser: an unknown code is
 * refused here, and the route still confirms the row exists and is active.
 */
const UNIVERSITY_CODES = new Set(UNIVERSITIES.map((uni) => uni.id));

/** Handles that would let someone impersonate the platform or its staff. */
const RESERVED_NICKNAMES = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'campushub', 'support', 'help',
  'staff', 'official', 'system', 'root', 'security', 'team', 'api', 'null',
  'undefined', 'me', 'you', 'settings', 'login', 'register', 'dashboard',
]);

/**
 * Password rule is length-first, deliberately. A 12-character minimum with no
 * composition requirements produces stronger passwords in practice than
 * "8 chars, one uppercase, one symbol", which reliably produces "Parol123!".
 * The only additional check is a breach-list lookup, done server-side.
 */
const password = z
  .string()
  .min(12, 'auth.errors.weakPassword')
  .max(200)
  .refine((v) => new Set(v).size >= 5, 'auth.errors.weakPassword');

/**
 * The two account types a person can register as.
 *
 * Deliberately a SUBSET of UserRole rather than a new enum. UserRole already
 * has STUDENT and MENTOR, already drives permissions, and is already what the
 * admin panel reads - so registration writes into the existing concept instead
 * of adding a parallel `accountType` that could disagree with it.
 *
 * MENTOR is self-service because a mentor has to be able to create an account
 * from zero - requiring them to register as a student first and then apply was
 * the bug that sent every signed-out mentor applicant to /login. Claiming the
 * role at signup grants NOTHING on its own: a MENTOR account still has to pass
 * identity verification, and it only becomes listable in the directory once a
 * moderator approves its application (POST /api/mentors/apply).
 *
 * ---------------------------------------------------------------------------
 * WHY TEACHER IS NO LONGER ONE OF THEM
 * ---------------------------------------------------------------------------
 * TEACHER and MENTOR were validated by the same refinements, asked for the
 * same two fields, and required the same documents - the choice between them
 * changed nothing downstream. It remains a perfectly good UserRole, assigned
 * by an administrator in the panel; it is simply not something a stranger
 * claims about themselves at signup. Removing it narrows what this endpoint
 * accepts, which is the safe direction: an existing TEACHER account is
 * untouched, and no other route reads ACCOUNT_TYPES.
 *
 * ALUMNI is likewise absent, but for a different reason: it is REACHED through
 * this endpoint rather than claimed at it. Someone registering as a student
 * who says they have already graduated is written as ALUMNI by the route - see
 * academicStatus below - and the graduation cron does the same for those who
 * finish later. MODERATOR and ADMIN are granted by an administrator only.
 */
export const ACCOUNT_TYPES = [UserRole.STUDENT, UserRole.MENTOR] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * The account types that describe a professional rather than an enrolled
 * student: they state where they work and what they do there, and have neither
 * a student card nor a graduation date - so they take one branch of the
 * refinements below and the identity-only document set in requiredKindsFor().
 */
const PROFESSIONAL_TYPES: ReadonlySet<AccountType> = new Set([UserRole.MENTOR]);

/**
 * Where a student is in their studies, asked alongside the university.
 *
 * GRADUATED is what turns a registration into an ALUMNI account (done in the
 * route, not here - this schema validates, it does not decide roles), and it
 * is what stops the platform demanding a current student card from someone who
 * finished three years ago.
 */
export const ACADEMIC_STATUSES = ['STUDYING', 'GRADUATED'] as const;
export type AcademicStatus = (typeof ACADEMIC_STATUSES)[number];

/** One half of a legal name, as printed on an identity document. */
const nameHalf = z
  .string()
  .trim()
  .min(2, 'errors.validationFailed')
  .max(60)
  // Latin-ext covers Azerbaijani diacritics; Cyrillic covers Russian names.
  // Digits and punctuation are rejected because they never appear on an ID.
  .regex(/^[\p{L}\s'-]+$/u, 'errors.validationFailed');

const MIN_AGE_YEARS = 16;
const MAX_AGE_YEARS = 100;

/**
 * Date of birth, as a calendar date.
 *
 * Accepted as YYYY-MM-DD and converted to a Date here, so nothing downstream
 * parses a string. The bounds are a plausibility check rather than a policy:
 * a university applicant younger than 16 or older than 100 is a typo far more
 * often than a real person, and the value is about to be compared against an
 * identity document.
 *
 * Constructed at UTC midnight. Using `new Date('2001-05-04')` alone is already
 * UTC, but a local-time constructor would shift the day backwards for anyone
 * east of Greenwich - which is everyone using this product.
 */
const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'auth.errors.dobInvalid')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), 'auth.errors.dobInvalid')
  .refine((d) => {
    const years = (Date.now() - d.getTime()) / (365.2425 * 86_400_000);
    return years >= MIN_AGE_YEARS && years <= MAX_AGE_YEARS;
  }, 'auth.errors.dobImplausible');

export const registerSchema = z
  .object({
    /**
     * The account type, chosen in step 2 of the wizard.
     *
     * Everything type-specific below is validated CONDITIONALLY against this
     * value in the refinements at the bottom, which is what stops a client
     * claiming STUDENT while omitting the student fields.
     */
    accountType: z.enum(ACCOUNT_TYPES),

    firstName: nameHalf,
    lastName: nameHalf,
    dateOfBirth,

    /**
     * Retained and still accepted so nothing that already posts a fullName
     * breaks. When absent it is derived from firstName + lastName in the
     * route, which is now the normal path.
     */
    fullName: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[\p{L}\s'-]+$/u, 'errors.validationFailed')
      .optional(),
    /**
     * Public handle. Everything social renders this, never fullName - which is
     * what lets a student take part without publishing the legal name that has
     * to match their ID document.
     */
    nickname: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_]{3,24}$/, 'auth.errors.nicknameInvalid')
      .refine((v) => !RESERVED_NICKNAMES.has(v.toLowerCase()), 'auth.errors.nicknameReserved'),
    email: z.string().trim().toLowerCase().email().max(254),
    password,
    passwordConfirm: z.string(),
    /**
     * University CODE, e.g. 'ADA'. See UNIVERSITY_CODES above.
     *
     * Optional at the field level because a MENTOR need not belong to a
     * university; the refinement below requires it for a STUDENT. An unknown
     * code is still refused - optional means "may be absent", not "may be
     * anything".
     */
    universityId: z
      .string()
      .trim()
      .refine((v) => UNIVERSITY_CODES.has(v), 'errors.validationFailed')
      .optional(),
    /**
     * A Firestore document id, NOT a cuid.
     *
     * `.cuid()` was wrong here even before the migration - it is the same
     * mistake documented on UNIVERSITY_CODES above, where a format check
     * rejected every real submission. It is now doubly wrong: Firestore mints
     * 20-character alphanumeric ids that no cuid matcher accepts, so this
     * would refuse every faculty the app itself created. The route confirms
     * the faculty exists; this only bounds the shape.
     */
    facultyId: z.string().trim().min(1).max(128).optional(),
    /**
     * Faculty, from the catalogue in src/lib/faculties.ts.
     *
     * Validated against the known slug set rather than as a free string. That
     * is what stops the column becoming a junk drawer of "CS", "comp sci" and
     * "Computer  Science", which would make it useless for the filtering and
     * mentor-matching it exists to support.
     *
     * `facultyId` above is a different thing and is left alone: it is the FK
     * to the per-university Faculty table, which has never been populated. See
     * the note on the User model for why both columns exist.
     */
    facultySlug: z
      .string()
      .trim()
      .refine((v) => FACULTY_SLUGS.has(v), 'errors.validationFailed')
      .optional(),
    /** The typed value when the catalogue choice is 'other'. */
    facultyOther: z.string().trim().min(2).max(120).optional(),

    // ---- STUDENT-specific --------------------------------------------------
    /**
     * University-issued student number, cross-checked against the student card.
     * Required for a STUDENT registration; see the refinement below.
     */
    studentNumber: z.string().trim().min(3).max(40).optional(),
    /**
     * "Currently studying" or "Graduated". Required for a STUDENT
     * registration; meaningless for a MENTOR, and refused on that branch by
     * the refinement below so a mentor account cannot carry one.
     */
    academicStatus: z.enum(ACADEMIC_STATUSES).optional(),

    // ---- MENTOR-specific ---------------------------------------------------
    /** Organisation the mentor works in (column shared with TEACHER accounts). */
    department: z.string().trim().min(2).max(120).optional(),
    /** Position, e.g. "Senior Product Manager", "Assistant Professor". */
    academicTitle: z.string().trim().min(2).max(120).optional(),
    /**
     * Weekly availability, picked on the wizard's schedule step. The same
     * rule shape and normalisation as POST /api/mentors/apply, so what is
     * chosen here can prefill that form unchanged. Required for a MENTOR (see
     * the refinement below); refused on the student branch.
     */
    availability: weeklyRulesSchema.optional(),
    /** IANA zone the availability is expressed in. */
    timezone: timezoneSchema.optional(),
    /**
     * Graduation date. Required for a STUDENT, meaningless for a TEACHER.
     *
     * Optional at the field level and required by the refinement below, which
     * is what lets one schema serve both account types without a teacher being
     * asked when they graduate.
     */
    graduationYear: z
      .number()
      .int()
      .min(CURRENT_YEAR - 15)
      .max(CURRENT_YEAR + 10)
      .optional(),
    graduationMonth: z.number().int().min(1).max(12).optional(),
    /**
     * Azerbaijani mobile number. REQUIRED - it is the strongest ban anchor the
     * platform has, because SIM registration here is identity-linked, so a
     * banned number is genuinely expensive to replace unlike an email address.
     */
    phone: z
      .string()
      .trim()
      .regex(/^(\+994|0)(50|51|55|70|77|10|60|99)\d{7}$/, 'auth.errors.phoneInvalid'),
    locale: z.enum(['az', 'en', 'ru']).default('az'),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'auth.errors.termsRequired' }) }),
    /**
     * Consent to identity-document processing is NO LONGER COLLECTED HERE.
     *
     * Registration does not touch a document any more, so a consent taken at
     * signup would be consent to processing that is not happening - and under
     * GDPR Art. 9 and the AZ personal data law, consent given before the
     * processing is specified is not consent at all. It is asked instead at
     * the moment the documents are handed over: POST /api/verification/submit
     * requires `consentDocumentProcessing` in its multipart body and refuses
     * the upload without it.
     *
     * The field stays accepted-but-ignored here so a client from the previous
     * deploy that still sends `true` is not answered with a 400 mid-rollout.
     * It is deliberately not passed to the user record.
     */
    consentDocumentProcessing: z.literal(true).optional(),
    /** Client-side signal only; never trusted on its own. */
    deviceFingerprint: z.string().max(128).optional(),
  })
  .refine((d) => d.password === d.passwordConfirm, {
    path: ['passwordConfirm'],
    message: 'auth.errors.passwordMismatch',
  })
  /**
   * ---------------------------------------------------------------------
   * THE TYPE-SPECIFIC REQUIREMENTS, ENFORCED SERVER-SIDE
   * ---------------------------------------------------------------------
   * These refinements are the reason a malicious client cannot post
   * `accountType: 'STUDENT'` while omitting the student fields, or register as
   * a TEACHER without the teacher fields. The wizard asks for the right things
   * per branch, but the wizard is a convenience - this is the control.
   *
   * Each refinement names its own `path`, so the error lands on the offending
   * field rather than at the form root where nobody can act on it.
   */
  .refine((d) => d.accountType !== UserRole.STUDENT || Boolean(d.universityId), {
    path: ['universityId'],
    message: 'errors.fieldRequired',
  })
  .refine((d) => d.accountType !== UserRole.STUDENT || Boolean(d.studentNumber), {
    path: ['studentNumber'],
    message: 'auth.errors.studentNumberRequired',
  })
  .refine((d) => d.accountType !== UserRole.STUDENT || Boolean(d.academicStatus), {
    path: ['academicStatus'],
    message: 'errors.fieldRequired',
  })
  /**
   * A mentor has no academic status, and accepting one would write a claim the
   * account type does not make. Refused rather than silently dropped, so a
   * client sending it learns that it is wrong instead of believing it landed.
   */
  .refine((d) => d.accountType === UserRole.STUDENT || d.academicStatus === undefined, {
    path: ['academicStatus'],
    message: 'errors.validationFailed',
  })
  /**
   * ---------------------------------------------------------------------
   * THE DATE MUST AGREE WITH THE STATUS
   * ---------------------------------------------------------------------
   * These two fields answer the same question twice, and when they disagree
   * the platform cannot tell which answer to believe - while the consequences
   * differ sharply: the status decides the ROLE written to the account, which
   * decides which documents verification will demand. "Graduated, finishing in
   * 2029" would produce an alumni account that can never complete
   * verification, because it would be asked for a student card it does not
   * have. Refusing here is the only point at which that is cheap to fix.
   *
   * The comparison is in whole months, at UTC, to match how the graduation
   * sweep reads the same pair. The CURRENT month is valid for BOTH: someone
   * defending this month is plausibly either.
   */
  .refine(
    (d) => {
      if (d.accountType !== UserRole.STUDENT) return true;
      if (d.graduationYear === undefined || d.graduationMonth === undefined) return true;

      const now = new Date();
      const chosen = d.graduationYear * 12 + d.graduationMonth;
      const current = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);

      if (d.academicStatus === 'GRADUATED') return chosen <= current;
      if (d.academicStatus === 'STUDYING') return chosen >= current;
      return true;
    },
    { path: ['graduationYear'], message: 'auth.errors.graduationStatusMismatch' },
  )
  .refine((d) => d.accountType !== UserRole.STUDENT || d.graduationYear !== undefined, {
    path: ['graduationYear'],
    message: 'errors.fieldRequired',
  })
  .refine((d) => d.accountType !== UserRole.STUDENT || d.graduationMonth !== undefined, {
    path: ['graduationMonth'],
    message: 'errors.fieldRequired',
  })
  .refine((d) => d.accountType !== UserRole.STUDENT || Boolean(d.facultySlug), {
    path: ['facultySlug'],
    message: 'errors.fieldRequired',
  })
  .refine((d) => !PROFESSIONAL_TYPES.has(d.accountType) || Boolean(d.department), {
    path: ['department'],
    message: 'auth.errors.departmentRequired',
  })
  .refine((d) => !PROFESSIONAL_TYPES.has(d.accountType) || Boolean(d.academicTitle), {
    path: ['academicTitle'],
    message: 'auth.errors.academicTitleRequired',
  })
  /**
   * A mentor states when they can be booked. At least one slot, because a
   * mentor with no availability is a listing nobody can ever book.
   */
  .refine((d) => d.accountType !== UserRole.MENTOR || (d.availability?.length ?? 0) > 0, {
    path: ['availability'],
    message: 'mentors.schedule.errors.empty',
  })
  .refine((d) => d.accountType === UserRole.MENTOR || d.availability === undefined, {
    path: ['availability'],
    message: 'errors.validationFailed',
  })
  /**
   * The two faculty columns are only coherent together, and the same pairing
   * is enforced by a CHECK constraint in the migration. Validating it here as
   * well means the user gets a field-level message instead of a 500 from a
   * constraint violation - the constraint is the guarantee, this is the UX.
   */
  .refine((d) => d.facultySlug !== FACULTY_OTHER || Boolean(d.facultyOther?.trim()), {
    path: ['facultyOther'],
    message: 'auth.errors.facultyOtherRequired',
  })
  .refine((d) => !d.facultyOther || d.facultySlug === FACULTY_OTHER, {
    path: ['facultyOther'],
    message: 'errors.validationFailed',
  });

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
  deviceFingerprint: z.string().max(128).optional(),
});

export const documentKindSchema = z.enum([
  'ID_FRONT',
  'ID_BACK',
  'STUDENT_CARD_FRONT',
  'STUDENT_CARD_BACK',
]);

/**
 * NOTE: there is no submitVerificationSchema any more.
 *
 * Documents arrive as a multipart body and are validated against their actual
 * BYTES in src/lib/verification/fileValidation.ts - magic-byte sniffing, header
 * dimension checks, PDF active-content rejection. A zod schema over a JSON
 * body of storage keys was the right shape when documents lived in S3; under
 * zero retention there are no keys to validate, and validating a client's
 * self-declared MIME string was never security in the first place.
 */
