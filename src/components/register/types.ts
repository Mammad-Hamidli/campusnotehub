import type { DocKind, DocState } from './DocumentDropzone';

/** Mirrors ACCOUNT_TYPES in src/server/validators/auth.ts. */
export type AccountType = 'STUDENT' | 'TEACHER' | 'MENTOR';

/**
 * The types that answer "where do you work" rather than "where do you study".
 * Mirrors PROFESSIONAL_TYPES in src/server/validators/auth.ts.
 */
export const PROFESSIONAL_TYPES: readonly AccountType[] = ['TEACHER', 'MENTOR'];
export const isProfessional = (t: AccountType | '') =>
  t === 'TEACHER' || t === 'MENTOR';

export type AccountForm = {
  /**
   * The legal name, in two halves.
   *
   * Collected separately because a document check compares given name and
   * surname independently. `fullName` below is derived from these on the
   * server and remains what every existing surface renders.
   */
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. Checked against the identity document during verification. */
  dateOfBirth: string;
  /** Chosen in step 2; decides which fields and documents follow. */
  accountType: AccountType | '';
  /** STUDENT only. */
  studentNumber: string;
  /** TEACHER only. */
  department: string;
  academicTitle: string;
  fullName: string;
  nickname: string;
  email: string;
  phone: string;
  password: string;
  universityId: string;
  /** Catalogue slug from src/lib/faculties.ts. '' until chosen. */
  facultySlug: string;
  /** Typed value, meaningful only when facultySlug === 'other'. */
  facultyOther: string;
  graduationYear: string;
  graduationMonth: string;
  acceptTerms: boolean;
  consentDocuments: boolean;
};

/** Values are locale KEYS, not sentences, so errors render in the active language. */
export type FieldErrors = Partial<Record<keyof AccountForm, string>>;

export type DocumentMap = Record<DocKind, DocState>;

/**
 * Field order for the error summary and for focus management.
 *
 * Declared once, here, so "jump to the first invalid field" and "list the
 * problems in the order they appear on screen" cannot drift apart from the
 * actual DOM order — which is what makes an error summary useless.
 */
export const FIELD_ORDER: (keyof AccountForm)[] = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'nickname',
  'email',
  'phone',
  'password',
  'accountType',
  'universityId',
  'studentNumber',
  'department',
  'academicTitle',
  'facultySlug',
  'facultyOther',
  'graduationYear',
  'graduationMonth',
  'acceptTerms',
  'consentDocuments',
];

/** Label keys for the error summary, so it reads "Nickname: required". */
export const FIELD_LABEL_KEYS: Record<keyof AccountForm, string> = {
  firstName: 'auth.register.firstName',
  lastName: 'auth.register.lastName',
  dateOfBirth: 'auth.register.dateOfBirth',
  accountType: 'auth.register.accountType',
  studentNumber: 'auth.register.studentNumber',
  department: 'auth.register.department',
  academicTitle: 'auth.register.academicTitle',
  fullName: 'auth.register.fullName',
  nickname: 'auth.register.nickname',
  email: 'auth.register.email',
  phone: 'auth.register.phone',
  password: 'auth.register.password',
  universityId: 'auth.register.university',
  facultySlug: 'auth.register.faculty',
  facultyOther: 'auth.register.facultyOther',
  graduationYear: 'auth.register.graduationYear',
  graduationMonth: 'auth.register.graduationMonth',
  acceptTerms: 'auth.register.termsShort',
  consentDocuments: 'auth.register.consentShort',
};

export const EMPTY_ACCOUNT: AccountForm = {
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  accountType: '',
  studentNumber: '',
  department: '',
  academicTitle: '',
  fullName: '',
  nickname: '',
  email: '',
  phone: '',
  password: '',
  universityId: '',
  facultySlug: '',
  facultyOther: '',
  graduationYear: '',
  graduationMonth: '',
  acceptTerms: false,
  consentDocuments: false,
};

/**
 * Identity documents, required of BOTH account types.
 *
 * Everyone proves who they are with the same two images.
 */
export const ID_SLOTS: { kind: DocKind; labelKey: string }[] = [
  { kind: 'ID_FRONT', labelKey: 'verification.slots.idFront' },
  { kind: 'ID_BACK', labelKey: 'verification.slots.idBack' },
];

/**
 * The student card, required of STUDENT only.
 *
 * Neither a teacher nor a mentor has a student card, so demanding one would
 * make their verification impossible to complete. The server applies the same
 * split in requiredKindsFor().
 */
export const STUDENT_CARD_SLOTS: { kind: DocKind; labelKey: string }[] = [
  { kind: 'STUDENT_CARD_FRONT', labelKey: 'verification.slots.studentFront' },
  { kind: 'STUDENT_CARD_BACK', labelKey: 'verification.slots.studentBack' },
];

/** All four. Retained for callers that iterate every possible slot. */
export const DOCUMENT_SLOTS: { kind: DocKind; labelKey: string }[] = [
  ...STUDENT_CARD_SLOTS,
  ...ID_SLOTS,
];

/** The slots one account type must actually fill. */
export function slotsFor(accountType: AccountType | ''): { kind: DocKind; labelKey: string }[] {
  // '' (not yet chosen) keeps the conservative full set, matching the server's
  // default in requiredKindsFor(): asking for an extra document is recoverable,
  // silently skipping one is not.
  return isProfessional(accountType) ? ID_SLOTS : DOCUMENT_SLOTS;
}

export const EMPTY_DOCUMENTS: DocumentMap = {
  STUDENT_CARD_FRONT: { phase: 'empty' },
  STUDENT_CARD_BACK: { phase: 'empty' },
  ID_FRONT: { phase: 'empty' },
  ID_BACK: { phase: 'empty' },
};

const RESERVED_NICKNAMES = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'campushub', 'support', 'help',
  'staff', 'official', 'system', 'root', 'security', 'team', 'api', 'null',
  'undefined', 'me', 'you', 'settings', 'login', 'register', 'dashboard',
]);

/**
 * Client-side mirror of registerSchema in src/server/validators/auth.ts.
 *
 * Duplicated deliberately: this one gives instant inline feedback, the server
 * one is the enforcement. They stay in sync by returning the same locale keys,
 * so changing a message is a single edit in the message bundles.
 *
 * EVERY field is required. There are no optional inputs in registration any
 * more — including the phone number, which is now the strongest ban anchor the
 * platform has.
 */
/**
 * Which fields a given step is responsible for.
 *
 * ---------------------------------------------------------------------------
 * WHY VALIDATION IS STEP-SCOPED
 * ---------------------------------------------------------------------------
 * Running the whole validator on step 1 demands `accountType`, which is not
 * chosen until step 2 - so step 1 could never be satisfied and the wizard was
 * impossible to advance past. The same trap applies in reverse: the
 * type-specific fields cannot be judged before the type exists.
 *
 * `scope` therefore says what is being checked right now. 'all' is the submit
 * path and is what the server mirrors.
 */
export type ValidationScope = 'basics' | 'all';

export function validateAccount(
  form: AccountForm,
  scope: ValidationScope = 'all',
): FieldErrors {
  const errors: FieldErrors = {};

  /**
   * Name halves.
   *
   * Digits and punctuation never appear on an ID; rejecting them here avoids a
   * mismatch the document cross-check would otherwise flag much later, after
   * the user has already uploaded four photographs.
   */
  const NAME_RE = /^[\p{L}\s'-]+$/u;

  const firstName = form.firstName.trim();
  if (!firstName) errors.firstName = 'errors.fieldRequired';
  else if (firstName.length < 2) errors.firstName = 'auth.errors.nameTooShort';
  else if (!NAME_RE.test(firstName)) errors.firstName = 'auth.errors.nameInvalid';

  const lastName = form.lastName.trim();
  if (!lastName) errors.lastName = 'errors.fieldRequired';
  else if (lastName.length < 2) errors.lastName = 'auth.errors.nameTooShort';
  else if (!NAME_RE.test(lastName)) errors.lastName = 'auth.errors.nameInvalid';

  /**
   * Date of birth. Mirrors the server's plausibility window rather than
   * inventing a second rule - a client that disagrees with the server just
   * produces a confusing round trip.
   */
  if (!form.dateOfBirth) {
    errors.dateOfBirth = 'errors.fieldRequired';
  } else {
    const dob = new Date(`${form.dateOfBirth}T00:00:00.000Z`);
    if (Number.isNaN(dob.getTime())) {
      errors.dateOfBirth = 'auth.errors.dobInvalid';
    } else {
      const years = (Date.now() - dob.getTime()) / (365.2425 * 86_400_000);
      if (years < 16 || years > 100) errors.dateOfBirth = 'auth.errors.dobImplausible';
    }
  }

  const nickname = form.nickname.trim();
  if (!nickname) errors.nickname = 'errors.fieldRequired';
  else if (!/^[a-zA-Z0-9_]{3,24}$/.test(nickname)) errors.nickname = 'auth.errors.nicknameInvalid';
  else if (RESERVED_NICKNAMES.has(nickname.toLowerCase()))
    errors.nickname = 'auth.errors.nicknameReserved';

  const email = form.email.trim();
  if (!email) errors.email = 'errors.fieldRequired';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'auth.errors.emailInvalid';

  const phone = form.phone.replace(/[\s-]/g, '');
  if (!phone) errors.phone = 'errors.fieldRequired';
  else if (!/^(\+994|0)(50|51|55|70|77|10|60|99)\d{7}$/.test(phone))
    errors.phone = 'auth.errors.phoneInvalid';

  if (!form.password) errors.password = 'errors.fieldRequired';
  else if (form.password.length < 12 || new Set(form.password).size < 5)
    errors.password = 'auth.errors.weakPassword';

  /**
   * Step 1 stops here.
   *
   * The university, the account type and everything that depends on it belong
   * to steps 2 and 3; reporting them as missing while the user is still on
   * step 1 is how the wizard became unadvanceable.
   */
  if (scope === 'basics') return errors;

  // Both account types belong to an institution.
  if (!form.universityId) errors.universityId = 'errors.fieldRequired';

  if (!form.accountType) errors.accountType = 'errors.fieldRequired';

  /**
   * Type-specific requirements, mirroring the refinements in
   * src/server/validators/auth.ts.
   *
   * This copy exists to show the error next to the field before a round trip -
   * NOT instead of the server check. A client that skips this still meets the
   * same rules on the server.
   */
  if (form.accountType === 'STUDENT') {
    if (!form.studentNumber.trim()) errors.studentNumber = 'auth.errors.studentNumberRequired';

    // Faculty: a catalogue choice is required, and the free text is required
    // only when that choice is 'other'. The same pairing is enforced by a zod
    // refinement and by a CHECK constraint.
    if (!form.facultySlug) errors.facultySlug = 'errors.fieldRequired';
    else if (form.facultySlug === 'other' && !form.facultyOther.trim())
      errors.facultyOther = 'auth.errors.facultyOtherRequired';

    if (!form.graduationYear) errors.graduationYear = 'errors.fieldRequired';
    if (!form.graduationMonth) errors.graduationMonth = 'errors.fieldRequired';
  }

  if (isProfessional(form.accountType)) {
    if (!form.department.trim()) errors.department = 'auth.errors.departmentRequired';
    if (!form.academicTitle.trim()) errors.academicTitle = 'auth.errors.academicTitleRequired';
  }
  if (!form.acceptTerms) errors.acceptTerms = 'auth.errors.termsRequired';
  if (!form.consentDocuments) errors.consentDocuments = 'auth.errors.consentRequired';

  return errors;
}

/**
 * Collects a browser fingerprint for the anti-fraud layer.
 *
 * This replaces IP tracking. It is a WEAK signal on its own — it drifts on
 * browser updates and resets with a fresh profile — and the server treats it
 * that way: combined with server-observed TLS signals, and never used to ban
 * automatically. Deliberately cheap: no font enumeration, no audio
 * fingerprint, nothing that takes more than a few milliseconds.
 */
export async function collectFingerprint(): Promise<string | undefined> {
  if (typeof window === 'undefined') return undefined;

  try {
    const parts: string[] = [];

    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 110, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('CampusHub əşı', 2, 15); // AZ diacritics probe the font stack
      parts.push(canvas.toDataURL().slice(-96));
    }

    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) parts.push(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)));
    }

    parts.push(
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      String(window.devicePixelRatio),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.language,
      String(navigator.hardwareConcurrency ?? ''),
      String(navigator.maxTouchPoints ?? ''),
    );

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    // A hardened browser produces no fingerprint. That is a legitimate
    // configuration, not an attack — signup proceeds without it.
    return undefined;
  }
}
