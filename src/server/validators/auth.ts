import { z } from 'zod';

const CURRENT_YEAR = new Date().getFullYear();

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

export const registerSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3)
      .max(120)
      // Latin-ext covers Azerbaijani diacritics; Cyrillic covers Russian names.
      // Digits and punctuation are rejected because they never appear on an ID.
      .regex(/^[\p{L}\s'-]+$/u, 'errors.validationFailed'),
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
    universityId: z.string().cuid(),
    facultyId: z.string().cuid().optional(),
    graduationYear: z
      .number()
      .int()
      .min(CURRENT_YEAR - 15)
      .max(CURRENT_YEAR + 10),
    // Required, not optional: the 1 May graduation sweep needs both halves of
    // the date to decide whether someone has actually graduated yet.
    graduationMonth: z.number().int().min(1).max(12),
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
    // Separate, explicit consent for biometric-adjacent document processing.
    // Bundling it into the terms checkbox would not be valid consent.
    consentDocumentProcessing: z.literal(true),
    /** Client-side signal only; never trusted on its own. */
    deviceFingerprint: z.string().max(128).optional(),
  })
  .refine((d) => d.password === d.passwordConfirm, {
    path: ['passwordConfirm'],
    message: 'auth.errors.passwordMismatch',
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
