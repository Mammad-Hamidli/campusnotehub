import { z } from 'zod';
import { USERNAME_PATTERN, isReservedUsername, parseLoginIdentifier } from '@/lib/auth/username';
import { normalizeAzPhone } from '@/lib/auth/phone';
import { UNIVERSITIES } from '@/lib/universities';

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

/**
 * Password rule is length-first, deliberately. A 12-character minimum with no
 * composition requirements produces stronger passwords in practice than
 * "8 chars, one uppercase, one symbol", which reliably produces "Parol123!".
 * The only additional check is a breach-list lookup, done server-side.
 */
export const passwordSchema = z
  .string()
  .min(12, 'auth.errors.weakPassword')
  .max(200)
  .refine((v) => new Set(v).size >= 5, 'auth.errors.weakPassword');
const password = passwordSchema;

/**
 * Forgotten password: the address only. Never a username - staff sign in by
 * email alone (see the login route), and a handle is public, so accepting one
 * would let anyone aim reset mail at an account knowing only its @name.
 */
export const forgotPasswordSchema = z
  .object({ email: z.string().trim().toLowerCase().email('auth.errors.emailInvalid').max(254) })
  .strict();

/** The link's token plus the new password. Same strength rule as registration. */
export const resetPasswordSchema = z
  .object({ token: z.string().max(64), password: passwordSchema })
  .strict();

/** Signed-in change. The current password is required: a live session alone is not enough. */
export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema })
  .strict()
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'auth.password.errors.sameAsCurrent',
    path: ['newPassword'],
  });

/**
 * Public handle. Everything social renders this, never the real name.
 * Shared with the login lookup and the usernames claim - see username.ts.
 */
export const nicknameSchema = z
  .string()
  .trim()
  .regex(USERNAME_PATTERN, 'auth.errors.nicknameInvalid')
  // Staff/brand names, their "admin_2" / "adm1n" variants, route names and
  // the temporary "user34232" handles - see isReservedUsername().
  .refine((v) => !isReservedUsername(v), 'auth.errors.nicknameReserved');

/**
 * The person's name, as ONE field.
 *
 * Letters, spaces, apostrophes and hyphens (Latin-ext covers Azerbaijani
 * diacritics, Cyrillic covers Russian names). The route splits it into
 * first/last for the verification cross-check; nothing here demands two words,
 * because plenty of people are known by one.
 */
export const fullNameSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(2, 'auth.errors.nameTooShort')
      .max(120)
      .regex(/^[\p{L}\s'-]+$/u, 'auth.errors.nameInvalid'),
  );

/**
 * University CODE, e.g. 'ADA'. See UNIVERSITY_CODES above. The route still
 * confirms the row exists and is active.
 */
export const universityCodeSchema = z
  .string()
  .trim()
  .refine((v) => UNIVERSITY_CODES.has(v), 'errors.fieldRequired');

/**
 * Mobile number, normalised to E.164 by the schema itself.
 *
 * The transform runs BEFORE the refine, so `input.phone` downstream is always
 * '+994501234567' no matter which of the three accepted spellings arrived.
 * That matters beyond tidiness: hashPhone() is what makes the number unique
 * across accounts, and an un-normalised value would let the same number be
 * registered twice by typing it differently the second time.
 */
export const phoneSchema = z
  .string()
  .trim()
  .max(20)
  .transform((v) => normalizeAzPhone(v))
  .refine((v): v is string => v !== null, 'auth.errors.phoneInvalid');

/**
 * Registration: ONE step, six fields.
 *
 *   name, nickname, university, personal email, phone, password (+ terms).
 *
 * The phone is back, and only the phone: date of birth, faculty, graduation
 * date and academic status stay gone from signup. It earns its place because
 * it is the account-recovery and payout-confirmation channel, and because it
 * is the second identifier the blocklist checks - collecting it at signup is
 * what lets a banned number be refused at signup rather than at first payout.
 * Identity is still proven the same way, later, at /verify; the capability
 * table in src/lib/permissions.ts is unchanged, so an unverified account still
 * cannot buy, sell, book or withdraw.
 *
 * The email is a PERSONAL address. A university address is not required (it
 * may be lost at graduation) - it only speeds up verification when given.
 *
 * Only students register here. Mentors apply on their own site (MENTORS_URL),
 * and quick-login accounts are created by the OAuth callback and finished at
 * /onboarding, so neither `accountType` nor `social` exists in this body any
 * more - an unknown key is stripped, never trusted.
 */
export const registerSchema = z
  .object({
    fullName: fullNameSchema,
    nickname: nicknameSchema,
    universityId: universityCodeSchema,
    email: z.string().trim().toLowerCase().email('auth.errors.emailInvalid').max(254),
    phone: phoneSchema,
    password,
    locale: z.enum(['az', 'en', 'ru']).default('az'),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'auth.errors.termsRequired' }) }),
    /** Client-side signal only; never trusted on its own. */
    deviceFingerprint: z.string().max(128).optional(),
  });

/**
 * Finishing a quick-login account at /onboarding. The same identity fields as
 * registration, INCLUDING a password: an account that can only be entered
 * through Google is lost the day that Google account is, so a local password
 * is required before the profile is usable. `email` is only accepted - and
 * then required - when the provider supplied none; the route decides which.
 */
export const completeProfileSchema = z.object({
  fullName: fullNameSchema,
  nickname: nicknameSchema,
  universityId: universityCodeSchema,
  password,
  email: z.string().trim().toLowerCase().email('auth.errors.emailInvalid').max(254).optional(),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'auth.errors.termsRequired' }) }),
});

/** Setting the FIRST password on an account that signed up through Google. */
export const setInitialPasswordSchema = z.object({ password: passwordSchema }).strict();

/** Splits a one-field name into the halves the verification check compares. */
export function splitFullName(fullName: string): { firstName: string; lastName: string | null } {
  const [first, ...rest] = fullName.trim().split(' ');
  return { firstName: first, lastName: rest.join(' ') || null };
}

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Login body. `identifier` is whatever was typed into the "email or username"
 * box; see parseLoginIdentifier() for how the two are told apart.
 *
 * `email` is still accepted as a legacy alias - tabs opened before this
 * release, scripts/e2e.mjs and any API client post that field - but only when
 * `identifier` is absent. Sending BOTH is refused rather than having one
 * silently win: a body that names two accounts is not something to guess about.
 */
export const loginSchema = z
  .object({
    identifier: z.string().max(254).optional(),
    email: z.string().max(254).optional(),
    password: z.string().min(1).max(200),
    deviceFingerprint: z.string().max(128).optional(),
  })
  .transform((body, ctx) => {
    if (body.identifier !== undefined && body.email !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'errors.validationFailed' });
      return z.NEVER;
    }
    const parsed = parseLoginIdentifier(body.identifier ?? body.email ?? '');
    // The legacy field can only ever name an email.
    const valid =
      parsed &&
      (body.email === undefined || parsed.kind === 'email') &&
      (parsed.kind === 'username' || z.string().email().safeParse(parsed.value).success);
    if (!valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'errors.validationFailed' });
      return z.NEVER;
    }
    return { identifier: parsed, password: body.password, deviceFingerprint: body.deviceFingerprint };
  });

export type LoginInput = z.infer<typeof loginSchema>;

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

/**
 * A second factor: EITHER an authenticator code OR a recovery code, never
 * both. Sending both is refused rather than trying one then the other - that
 * would spend a failed attempt on one factor while the other one succeeds,
 * and make the lockout arithmetic depend on field order.
 *
 * Lengths are generous for formatting ("123 456", "ABCD-EFGH-...") and tight
 * enough that nothing large reaches a hash or a transaction.
 */
const secondFactorFields = {
  code: z.string().trim().max(16).optional(),
  recoveryCode: z.string().trim().max(32).optional(),
};
const exactlyOneFactor = (d: { code?: string; recoveryCode?: string }) =>
  (d.code !== undefined && d.code !== '') !== (d.recoveryCode !== undefined && d.recoveryCode !== '');

export const secondFactorSchema = z
  .object(secondFactorFields)
  .strict()
  .refine(exactlyOneFactor, { message: 'errors.validationFailed' });

/** Setup takes an OPTIONAL second factor: required only when replacing one. */
export const mfaSetupSchema = z
  .object(secondFactorFields)
  .strict()
  .refine((d) => (!d.code && !d.recoveryCode) || exactlyOneFactor(d), { message: 'errors.validationFailed' });

export const mfaConfirmSchema = z.object({ code: z.string().trim().min(6).max(16) }).strict();

export const mfaVerifySchema = z
  // ticket is optional: a social sign-in delivers it in the CH_MT cookie instead.
  .object({ ticket: z.string().min(1).max(64).optional(), ...secondFactorFields })
  .strict()
  .refine(exactlyOneFactor, { message: 'errors.validationFailed' });
