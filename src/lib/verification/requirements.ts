/**
 * Which identity documents an account must submit - the ONE copy of the rule.
 *
 * Client-safe (no server imports): the settings verification section renders
 * from it and POST /api/verification/submit enforces it, so the screen and the
 * server cannot disagree about what a given account is asked for. There used
 * to be two hand-maintained copies (slotsFor in the register types and
 * requiredKindsFor in the submit route); a drift between them produces either
 * an upload screen the server rejects or a server that accepts less than the
 * screen promised.
 *
 *   STUDENT (currently studying)  - national ID + student ID
 *   ALUMNI  (graduated)           - national ID only
 *   MENTOR / TEACHER              - national ID only
 *
 * A "Graduated" registration is written as role ALUMNI (see the register
 * route), so academic status reaches this function through the role. Always
 * pass the STORED role: a client cannot shrink its own requirements by
 * claiming to be something else.
 */

export type DocumentKind = 'ID_FRONT' | 'ID_BACK' | 'STUDENT_CARD_FRONT' | 'STUDENT_CARD_BACK';

export const ID_KINDS = ['ID_FRONT', 'ID_BACK'] as const satisfies readonly DocumentKind[];
export const STUDENT_CARD_KINDS = [
  'STUDENT_CARD_FRONT',
  'STUDENT_CARD_BACK',
] as const satisfies readonly DocumentKind[];

/**
 * Why an account gets the document set it gets. Drives the explanatory copy
 * in the settings section, so a mentor who sees two slots where a friend saw
 * four is told why instead of wondering whether something failed to load.
 */
export type RequirementReason = 'STUDYING' | 'GRADUATED' | 'PROFESSIONAL';

/** Roles that hold no CURRENT student card, so prove identity only. */
const IDENTITY_ONLY_ROLES: Readonly<Record<string, RequirementReason>> = {
  ALUMNI: 'GRADUATED',
  MENTOR: 'PROFESSIONAL',
  TEACHER: 'PROFESSIONAL',
};

export function requirementReasonFor(role: string): RequirementReason {
  // STUDENT, and any role this table does not know, also proves enrolment.
  // That is the conservative default: asking for an extra document is
  // recoverable, silently skipping one is not.
  return IDENTITY_ONLY_ROLES[role] ?? 'STUDYING';
}

export function requiredKindsFor(role: string): readonly DocumentKind[] {
  return requirementReasonFor(role) === 'STUDYING' ? [...ID_KINDS, ...STUDENT_CARD_KINDS] : ID_KINDS;
}

/**
 * Where verification happens: the Verification section of Settings. The
 * banner, the gated-feature messages and the legacy /verify route all point
 * here, so it is one constant rather than a string repeated in each.
 */
export const VERIFICATION_SETTINGS_HREF = '/settings?tab=verification';
