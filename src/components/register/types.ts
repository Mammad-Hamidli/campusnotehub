import type { DocKind, DocState } from './DocumentDropzone';
import { requiredKindsFor } from '@/lib/verification/requirements';
import { normalizeAzPhone } from '@/lib/auth/phone';

/**
 * The registration form: ONE step, six fields (+ terms).
 *
 * Also the shape /onboarding finishes for a quick-login account, which has no
 * password, no phone and usually already has its provider's email - see
 * `options` on validateProfile().
 */
export type ProfileForm = {
  fullName: string;
  nickname: string;
  /** University CODE ('ADA'), as the server's registerSchema expects. */
  universityId: string;
  /** A PERSONAL address - a university one is welcome but not required. */
  email: string;
  /**
   * As TYPED. Any of '+994 50 123 45 67', '050 123 45 67' or '994501234567'
   * is accepted here; normalisePhone() below collapses them to one E.164
   * string before the value ever reaches the payload, so the server is never
   * asked to guess which of three spellings a number was entered in.
   */
  phone: string;
  password: string;
  acceptTerms: boolean;
};

/** Values are locale KEYS, not sentences, so errors render in the active language. */
export type ProfileErrors = Partial<Record<keyof ProfileForm, string>>;

export type DocumentMap = Record<DocKind, DocState>;

/** Screen order - the error summary lists and focuses problems in this order. */
export const FIELD_ORDER: (keyof ProfileForm)[] = [
  'fullName',
  'nickname',
  'universityId',
  'email',
  'phone',
  'password',
  'acceptTerms',
];

/** Label keys for the error summary, so it reads "Nickname: required". */
export const FIELD_LABEL_KEYS: Record<keyof ProfileForm, string> = {
  fullName: 'auth.register.fullName',
  nickname: 'auth.register.nickname',
  universityId: 'auth.register.university',
  email: 'auth.register.personalEmail',
  phone: 'auth.register.phone',
  password: 'auth.register.password',
  acceptTerms: 'auth.register.termsShort',
};

export const EMPTY_PROFILE: ProfileForm = {
  fullName: '',
  nickname: '',
  universityId: '',
  email: '',
  phone: '',
  password: '',
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
  'onboarding', 'mentors', 'profile',
]);

/**
 * Client-side mirror of registerSchema / completeProfileSchema in
 * src/server/validators/auth.ts. This one gives instant inline feedback; the
 * server is the enforcement. Both return the same locale keys.
 */
export function validateProfile(
  form: ProfileForm,
  options: { requirePassword: boolean; requireEmail: boolean; requirePhone?: boolean },
): ProfileErrors {
  const errors: ProfileErrors = {};

  const fullName = form.fullName.trim().replace(/\s+/g, ' ');
  if (!fullName) errors.fullName = 'errors.fieldRequired';
  else if (fullName.length < 2) errors.fullName = 'auth.errors.nameTooShort';
  else if (!/^[\p{L}\s'-]+$/u.test(fullName)) errors.fullName = 'auth.errors.nameInvalid';

  const nickname = form.nickname.trim();
  if (!nickname) errors.nickname = 'errors.fieldRequired';
  else if (!/^[a-zA-Z0-9_]{3,24}$/.test(nickname)) errors.nickname = 'auth.errors.nicknameInvalid';
  else if (RESERVED_NICKNAMES.has(nickname.toLowerCase()) || /^user\d{5}$/i.test(nickname))
    errors.nickname = 'auth.errors.nicknameReserved';

  if (!form.universityId) errors.universityId = 'errors.fieldRequired';

  if (options.requireEmail) {
    const email = form.email.trim();
    if (!email) errors.email = 'errors.fieldRequired';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'auth.errors.emailInvalid';
  }

  /**
   * The phone is only asked for at registration, never at /onboarding - a
   * quick-login account is finishing a profile, and the recovery number can be
   * added from Settings. Validating it here means a mistyped number is caught
   * before the request, rather than coming back as the deliberately vague
   * 'credentialsUnavailable' that a server-side clash produces.
   */
  if (options.requirePhone) {
    const phone = form.phone.trim();
    if (!phone) errors.phone = 'errors.fieldRequired';
    else if (!normalizeAzPhone(phone)) errors.phone = 'auth.errors.phoneInvalid';
  }

  if (options.requirePassword) {
    if (!form.password) errors.password = 'errors.fieldRequired';
    else if (form.password.length < 12 || new Set(form.password).size < 5)
      errors.password = 'auth.errors.weakPassword';
  }

  if (!form.acceptTerms) errors.acceptTerms = 'auth.errors.termsRequired';
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
