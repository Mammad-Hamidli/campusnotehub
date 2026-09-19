import type { DocKind, DocState } from './DocumentDropzone';
import { requiredKindsFor } from '@/lib/verification/requirements';

/**
 * The account types a person may CHOOSE at signup.
 *
 * Mirrors ACCOUNT_TYPES in src/server/validators/auth.ts, which is now two
 * values rather than three. TEACHER still exists as a UserRole - accounts
 * already hold it and an administrator can still assign it - but it is no
 * longer offered at registration: a teacher and a mentor were asked for
 * exactly the same two fields and the same documents, so the third card
 * bought a decision and nothing else.
 */
export type AccountType = 'STUDENT' | 'MENTOR';

/**
 * The types that answer "where do you work" rather than "where do you study".
 * Mirrors PROFESSIONAL_TYPES in src/server/validators/auth.ts.
 */
export const PROFESSIONAL_TYPES: readonly AccountType[] = ['MENTOR'];
export const isProfessional = (t: AccountType | '') => t === 'MENTOR';

/**
 * Where a student is in their studies.
 *
 * This is the "Graduated / Currently studying" choice, and it is asked in the
 * same block as the university because it is the same question: which
 * institution, and are you still there. It decides three things downstream:
 *
 *   - the role written at registration (ALUMNI vs STUDENT);
 *   - whether the graduation date is read as a past fact or a future plan;
 *   - which documents verification asks for later - an alumnus has no current
 *     student card, so demanding one would make their verification impossible.
 */
export type AcademicStatus = 'STUDYING' | 'GRADUATED';

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
  /** Chosen in step 2; decides which fields follow. */
  accountType: AccountType | '';
  /** STUDENT only. */
  studentNumber: string;
  /** STUDENT only: 'STUDYING' or 'GRADUATED'. See AcademicStatus. */
  academicStatus: AcademicStatus | '';
  /** MENTOR only. */
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
  /**
   * MENTOR only: the weekly availability picked in the schedule step, as the
   * AvailabilityGrid's "weekday:minute" cell keys. Sent as merged rules
   * (cellsToRules) and carried into the mentor application later.
   */
  availability: Set<string>;
  /** MENTOR only: IANA zone the availability is expressed in. */
  timezone: string;
  acceptTerms: boolean;
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
  'academicStatus',
  'studentNumber',
  'department',
  'academicTitle',
  'facultySlug',
  'facultyOther',
  'graduationYear',
  'graduationMonth',
  'timezone',
  'availability',
  'acceptTerms',
];

/** Label keys for the error summary, so it reads "Nickname: required". */
export const FIELD_LABEL_KEYS: Record<keyof AccountForm, string> = {
  firstName: 'auth.register.firstName',
  lastName: 'auth.register.lastName',
  dateOfBirth: 'auth.register.dateOfBirth',
  accountType: 'auth.register.accountType',
  studentNumber: 'auth.register.studentNumber',
  academicStatus: 'auth.register.academicStatus',
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
  availability: 'mentors.schedule.weekly',
  timezone: 'mentors.schedule.timezone',
  acceptTerms: 'auth.register.termsShort',
};

export const EMPTY_ACCOUNT: AccountForm = {
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  accountType: '',
  studentNumber: '',
  academicStatus: '',
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
  // Never mutated in place - the grid always produces a new Set - so sharing
  // this one instance between wizard mounts is safe.
  availability: new Set<string>(),
  timezone: 'Asia/Baku',
  acceptTerms: false,
};

const SLOT_LABELS: Record<DocKind, string> = {
  ID_FRONT: 'verification.slots.idFront',
  ID_BACK: 'verification.slots.idBack',
  STUDENT_CARD_FRONT: 'verification.slots.studentFront',
  STUDENT_CARD_BACK: 'verification.slots.studentBack',
};

/**
 * The slots one ROLE must actually fill, in display order.
 *
 * A thin view over requiredKindsFor() in src/lib/verification/requirements.ts,
 * which the submit route enforces - so the screen can never ask for a
 * different set than the server accepts. Takes the STORED role, which may be
 * one signup cannot produce (TEACHER from an admin).
 */
export function slotsFor(role: string): { kind: DocKind; labelKey: string }[] {
  return requiredKindsFor(role).map((kind) => ({ kind, labelKey: SLOT_LABELS[kind] }));
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
 * `scope` therefore says what is being checked right now:
 *   basics  - step 1, the common fields;
 *   details - everything except the mentor's schedule (step 4 for mentors);
 *   all     - the submit path, and what the server mirrors.
 */
export type ValidationScope = 'basics' | 'details' | 'all';

/**
 * Client-side mirror of registerSchema in src/server/validators/auth.ts.
 *
 * Duplicated deliberately: this one gives instant inline feedback, the server
 * one is the enforcement. They stay in sync by returning the same locale keys,
 * so changing a message is a single edit in the message bundles.
 *
 * NOTE what is no longer here: the document-processing consent. Registration
 * does not touch a document any more, so consenting to document processing at
 * signup would be consent to something that is not happening yet - which is
 * not valid consent. It is asked on /verify, at the moment the documents are
 * actually handed over.
 */
export function validateAccount(
  form: AccountForm,
  scope: ValidationScope = 'all',
): FieldErrors {
  const errors: FieldErrors = {};

  /**
   * Name halves.
   *
   * Digits and punctuation never appear on an ID; rejecting them here avoids a
   * mismatch the document cross-check would otherwise flag much later.
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

  // A student is enrolled somewhere by definition. A mentor is often an
  // industry professional with no university, so for them it is optional -
  // mirrored by the STUDENT-only refinement in src/server/validators/auth.ts.
  if (form.accountType !== 'MENTOR' && !form.universityId) errors.universityId = 'errors.fieldRequired';

  if (!form.accountType) errors.accountType = 'errors.fieldRequired';

  /**
   * Type-specific requirements, mirroring the refinements in
   * src/server/validators/auth.ts.
   *
   * This copy exists to show the error next to the field before a round trip -
   * NOT instead of the server check.
   */
  if (form.accountType === 'STUDENT') {
    // Asked in the same block as the university: which institution, and are
    // you still there. Everything below reads differently depending on it.
    if (!form.academicStatus) errors.academicStatus = 'errors.fieldRequired';

    if (!form.studentNumber.trim()) errors.studentNumber = 'auth.errors.studentNumberRequired';

    // Faculty: a catalogue choice is required, and the free text is required
    // only when that choice is 'other'.
    if (!form.facultySlug) errors.facultySlug = 'errors.fieldRequired';
    else if (form.facultySlug === 'other' && !form.facultyOther.trim())
      errors.facultyOther = 'auth.errors.facultyOtherRequired';

    if (!form.graduationYear) errors.graduationYear = 'errors.fieldRequired';
    if (!form.graduationMonth) errors.graduationMonth = 'errors.fieldRequired';

    /**
     * The date has to agree with the status.
     *
     * Someone who says they have graduated but names a date two years out has
     * answered one of the two questions wrongly - and the wrong one silently
     * decides their role and which documents they will be asked for. Catching
     * it here is the difference between correcting a dropdown now and an
     * alumni account that cannot complete verification later.
     */
    if (form.academicStatus && form.graduationYear && form.graduationMonth) {
      const now = new Date();
      const chosen = Number(form.graduationYear) * 12 + Number(form.graduationMonth);
      const current = now.getFullYear() * 12 + (now.getMonth() + 1);

      if (form.academicStatus === 'GRADUATED' && chosen > current)
        errors.graduationYear = 'auth.errors.graduationNotPast';
      if (form.academicStatus === 'STUDYING' && chosen < current)
        errors.graduationYear = 'auth.errors.graduationNotFuture';
    }
  }

  if (isProfessional(form.accountType)) {
    if (!form.department.trim()) errors.department = 'auth.errors.departmentRequired';
    if (!form.academicTitle.trim()) errors.academicTitle = 'auth.errors.academicTitleRequired';
  }
  if (!form.acceptTerms) errors.acceptTerms = 'auth.errors.termsRequired';

  /**
   * The mentor's schedule is its own step, after details, so it is judged
   * only on the submit path. Mirrors the MENTOR refinement in
   * src/server/validators/auth.ts: at least one bookable slot, because a
   * mentor with no availability can never be booked.
   */
  if (scope === 'all' && form.accountType === 'MENTOR') {
    if (!form.timezone) errors.timezone = 'errors.fieldRequired';
    if (form.availability.size === 0) errors.availability = 'mentors.schedule.errors.empty';
  }

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
