import type { DocKind, DocState } from './DocumentDropzone';

export type AccountForm = {
  fullName: string;
  nickname: string;
  email: string;
  phone: string;
  password: string;
  universityId: string;
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
  'fullName',
  'nickname',
  'email',
  'phone',
  'password',
  'universityId',
  'graduationYear',
  'graduationMonth',
  'acceptTerms',
  'consentDocuments',
];

/** Label keys for the error summary, so it reads "Nickname: required". */
export const FIELD_LABEL_KEYS: Record<keyof AccountForm, string> = {
  fullName: 'auth.register.fullName',
  nickname: 'auth.register.nickname',
  email: 'auth.register.email',
  phone: 'auth.register.phone',
  password: 'auth.register.password',
  universityId: 'auth.register.university',
  graduationYear: 'auth.register.graduationYear',
  graduationMonth: 'auth.register.graduationMonth',
  acceptTerms: 'auth.register.termsShort',
  consentDocuments: 'auth.register.consentShort',
};

export const EMPTY_ACCOUNT: AccountForm = {
  fullName: '',
  nickname: '',
  email: '',
  phone: '',
  password: '',
  universityId: '',
  graduationYear: '',
  graduationMonth: '',
  acceptTerms: false,
  consentDocuments: false,
};

export const DOCUMENT_SLOTS: { kind: DocKind; labelKey: string }[] = [
  { kind: 'STUDENT_CARD_FRONT', labelKey: 'verification.slots.studentFront' },
  { kind: 'STUDENT_CARD_BACK', labelKey: 'verification.slots.studentBack' },
  { kind: 'ID_FRONT', labelKey: 'verification.slots.idFront' },
  { kind: 'ID_BACK', labelKey: 'verification.slots.idBack' },
];

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
export function validateAccount(form: AccountForm): FieldErrors {
  const errors: FieldErrors = {};

  const fullName = form.fullName.trim();
  if (!fullName) errors.fullName = 'errors.fieldRequired';
  else if (fullName.length < 3) errors.fullName = 'auth.errors.nameTooShort';
  // Digits and punctuation never appear on an ID; rejecting them here avoids a
  // mismatch the OCR cross-check would otherwise flag much later.
  else if (!/^[\p{L}\s'-]+$/u.test(fullName)) errors.fullName = 'auth.errors.nameInvalid';

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

  if (!form.universityId) errors.universityId = 'errors.fieldRequired';
  if (!form.graduationYear) errors.graduationYear = 'errors.fieldRequired';
  if (!form.graduationMonth) errors.graduationMonth = 'errors.fieldRequired';
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
