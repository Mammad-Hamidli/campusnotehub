import { z } from 'zod';
import { AccountStatus, UserRole, VerificationStatus } from '@/lib/enums';

/**
 * Query and mutation schemas for the admin panel.
 *
 * Two rules shape this file:
 *
 *  1. SORT AND FILTER FIELDS ARE ENUMS, NEVER FREE STRINGS. `orderBy` is
 *     interpolated straight into a Prisma query; accepting an arbitrary column
 *     name lets a caller order by `passwordHash` and read it one bit at a time
 *     through the resulting row order. The allow-list below is the fix, and it
 *     is why `sort` is a z.enum rather than a z.string().
 *
 *  2. PAGE SIZE IS CAPPED. Without a ceiling, `?pageSize=1000000` turns a
 *     listing endpoint into a full-table export - the exact shape of a scraping
 *     incident, and it would be an authenticated one that looks legitimate in
 *     the logs.
 */

/** Shared by every listing endpoint here. */
const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

/** Empty query-string values arrive as '' and must not be treated as filters. */
const optionalString = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => (v ? v : undefined));

const optionalDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
  .optional()
  .transform((v) => (v ? new Date(v) : undefined));

export const USER_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'lastLoginAt',
  'fullName',
  'nickname',
  'email',
  'verificationStatus',
  'accountStatus',
  'role',
] as const;

export const adminUserListSchema = z.object({
  ...pagination,
  /** Matched against full name, nickname and email. Never against a hash. */
  q: optionalString,
  role: z.nativeEnum(UserRole).optional(),
  accountStatus: z.nativeEnum(AccountStatus).optional(),
  verificationStatus: z.nativeEnum(VerificationStatus).optional(),
  universityId: optionalString,
  createdFrom: optionalDate,
  createdTo: optionalDate,
  sort: z.enum(USER_SORT_FIELDS).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  /**
   * Soft-deleted accounts are hidden by default. They remain reachable so an
   * admin can audit a deletion, but they must not silently pad user counts or
   * appear in routine listings as if they were live accounts.
   */
  includeDeleted: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AdminUserListInput = z.infer<typeof adminUserListSchema>;

/**
 * Account status changes an admin may make.
 *
 * BANNED and DELETED are deliberately absent. Banning for document fraud runs
 * through applyBan() so the blocklist rows are written with it - setting the
 * column directly here would produce a banned account whose email and phone are
 * not on the blocklist, letting the same person re-register immediately.
 * Deletion has its own endpoint because it is a different kind of action.
 */
export const adminStatusChangeSchema = z.object({
  accountStatus: z.enum([AccountStatus.ACTIVE, AccountStatus.RESTRICTED, AccountStatus.SUSPENDED]),
  reason: z.string().trim().min(10).max(1000),
});

/**
 * Role changes. ADMIN-only, enforced in the handler as well as here.
 *
 * ---------------------------------------------------------------------------
 * WHY ALL SIX ROLES ARE NOW GRANTABLE
 * ---------------------------------------------------------------------------
 * This used to accept STUDENT, MODERATOR and ADMIN only, on the reasoning that
 * STUDENT -> ALUMNI belongs to the graduation cron and MENTOR belongs to the
 * mentor application flow, so setting either by hand would produce a state
 * those systems did not create.
 *
 * That reasoning holds for the AUTOMATED transitions and it is unchanged: the
 * cron and the application flow still own their own paths. What it did not
 * account for is the admin acting as the system of last resort - a graduate
 * whose cohort the sweep missed, a lecturer who must be TEACHER on day one, a
 * mentor approved out of band. Refusing those forced the operator to edit the
 * database directly, which is strictly worse: no audit row, no reason, no
 * confirmation, and no session revocation.
 *
 * So the full enum is grantable, and the safeguards live where they belong -
 * in the handler, which still refuses self-demotion and still refuses to
 * remove the last ADMIN, and which now revokes sessions on a privilege change
 * so a demoted operator's open tabs stop working immediately.
 */
export const ASSIGNABLE_ROLES = [
  UserRole.STUDENT,
  UserRole.ALUMNI,
  UserRole.MENTOR,
  UserRole.TEACHER,
  UserRole.MODERATOR,
  UserRole.ADMIN,
] as const;

/**
 * Roles that grant power over other people's accounts.
 *
 * Named here rather than inlined at the call sites so the UI's "are you sure"
 * step and the server's audit tagging cannot disagree about which grants are
 * sensitive.
 */
export const PRIVILEGED_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.MODERATOR,
  UserRole.ADMIN,
]);

export const adminRoleChangeSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  reason: z.string().trim().min(10).max(1000),
});

/**
 * Temporary account freeze.
 *
 * `until` is optional: its absence means an indefinite suspension, which is
 * the behaviour that already existed via adminStatusChangeSchema. When it is
 * present it must be in the future and within a year - a "temporary" freeze
 * measured in decades is a ban wearing a disguise, and bans have their own
 * path precisely because they carry blocklist rows with them.
 */
const MAX_FREEZE_DAYS = 365;

export const adminFreezeSchema = z.object({
  reason: z.string().trim().min(10).max(1000),
  until: z
    .string()
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .refine((d) => !d || d.getTime() > Date.now(), 'admin.users.errors.freezeUntilPast')
    .refine(
      (d) => !d || d.getTime() <= Date.now() + MAX_FREEZE_DAYS * 86_400_000,
      'admin.users.errors.freezeTooLong',
    ),
});

/**
 * Approving a pending account and assigning its role in one step.
 *
 * The role is REQUIRED rather than defaulted to STUDENT: an admin approving an
 * account has the applicant's documents in front of them and is the only party
 * who knows whether they are a student, a lecturer or an alumnus. Defaulting
 * silently would mean every approval quietly asserts "student", and the
 * mistake would only surface when a lecturer could not offer mentoring.
 */
export const adminApproveWithRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  reason: z.string().trim().min(10).max(1000).optional(),
  /**
   * Echoed back by the client for a privileged grant, mirroring the delete
   * endpoint's confirmNickname. A client that skips the dialog must not skip
   * the safeguard.
   */
  confirmPrivileged: z.boolean().optional(),
});

/**
 * Setting an account's verification outcome directly from the users list.
 *
 * This is NOT a shortcut around the moderation console, and the difference
 * matters. The console decides a CASE: it holds the per-case decryption
 * secret, shows the documents, and is the only surface that can ban for fraud.
 * This decides an ACCOUNT, for the situations that have no live case to
 * work - a student verified out of band, a stale VERIFIED flag that has to be
 * withdrawn, an account whose case expired before a human reached it.
 *
 * Because no documents are involved, BANNED is deliberately not an option
 * here: a fraud ban must be issued against a case somebody actually looked at,
 * which is the rule stated in decide() and enforced by the console.
 */
export const adminVerificationSetSchema = z.object({
  verificationStatus: z.enum([VerificationStatus.VERIFIED, VerificationStatus.REJECTED]),
  reason: z.string().trim().min(10).max(1000),
  /** Optional role to grant alongside an approval. See the note on approvals. */
  role: z.enum(ASSIGNABLE_ROLES).optional(),
  confirmPrivileged: z.boolean().optional(),
});

/** Removing a decided case from the queue view. Never a delete - see the model. */
export const adminDismissCaseSchema = z.object({
  /** false restores the row to the queue. */
  dismissed: z.boolean().default(true),
});

export const adminDeleteUserSchema = z.object({
  reason: z.string().trim().min(10).max(1000),
  /** The client must echo the nickname back. Guards against a mis-aimed click. */
  confirmNickname: z.string().trim().min(1).max(24),
});

export const adminRevokeSessionsSchema = z.object({
  reason: z.string().trim().min(10).max(1000),
});

/**
 * Removing another account's second factor. The acting ADMIN proves their OWN
 * factor in the same request, so a hijacked admin session alone cannot strip
 * 2FA from the accounts it wants to take over next.
 */
export const adminMfaResetSchema = z
  .object({
    reason: z.string().trim().min(10).max(1000),
    code: z.string().trim().max(16).optional(),
    recoveryCode: z.string().trim().max(32).optional(),
  })
  .strict()
  .refine((d) => !!d.code !== !!d.recoveryCode, { message: 'errors.validationFailed' });

export const adminNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

export const VERIFICATION_QUEUE_STATUSES = [
  VerificationStatus.NEEDS_REVIEW,
  VerificationStatus.PROCESSING,
  VerificationStatus.REJECTED,
  VerificationStatus.VERIFIED,
  VerificationStatus.BANNED,
] as const;

export const adminVerificationListSchema = z.object({
  ...pagination,
  status: z.nativeEnum(VerificationStatus).optional(),
  q: optionalString,
  /**
   * `reviewPriority` is retained as a sort key even though the column is no
   * longer SHOWN in the table. It still orders the moderator queue usefully
   * (integrity signals first), and dropping it from the allow-list would break
   * any bookmarked URL that carries it.
   */
  sort: z.enum(['submittedAt', 'reviewPriority', 'decidedAt', 'updatedAt']).default('submittedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  /**
   * Rows an operator has cleared from their view are hidden by default. They
   * are not deleted and remain reachable with includeDismissed=true, which is
   * what keeps "cleared from the queue" separate from "gone from the record".
   */
  includeDismissed: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const adminAuditListSchema = z.object({
  ...pagination,
  q: optionalString,
  action: optionalString,
  entityType: optionalString,
  entityId: optionalString,
  actorId: optionalString,
  createdFrom: optionalDate,
  createdTo: optionalDate,
});

/**
 * University writes.
 *
 * `code` is immutable once created and so is absent from the update schema: it
 * is what the registration form submits as `universityId` and what
 * verification compares a student card against, so renaming one would orphan
 * every existing account attached to it.
 */
export const adminUniversityCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[\p{Lu}\p{Lt}0-9]+$/u, 'admin.universities.codeInvalid'),
  nameAz: z.string().trim().min(2).max(200),
  nameEn: z.string().trim().min(2).max(200),
  nameRu: z.string().trim().min(2).max(200),
  city: z.string().trim().min(2).max(100),
  emailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'admin.universities.domainInvalid'),
    )
    .max(10)
    .default([]),
  isActive: z.boolean().default(true),
});

export const adminUniversityUpdateSchema = z.object({
  nameAz: z.string().trim().min(2).max(200).optional(),
  nameEn: z.string().trim().min(2).max(200).optional(),
  nameRu: z.string().trim().min(2).max(200).optional(),
  city: z.string().trim().min(2).max(100).optional(),
  emailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'admin.universities.domainInvalid'),
    )
    .max(10)
    .optional(),
  isActive: z.boolean().optional(),
});
