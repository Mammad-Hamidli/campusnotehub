/**
 * The decision policy: pure functions, no I/O, fully unit-testable.
 *
 * This is the code that decides whether a real 19-year-old keeps access to
 * their account, their notes, and their wallet balance. It is deliberately the
 * simplest, most inspectable module in the codebase.
 */

export type SignalCode =
  // --- integrity (probabilistic, from the AI/OCR service) ------------------
  | 'SCREEN_RECAPTURE' // moire pattern: a photo of a monitor
  | 'DIGITAL_TAMPERING' // ELA + copy-move: pixels edited
  | 'EDITOR_METADATA' // EXIF names Photoshop / GIMP / a generator
  | 'TEMPLATE_MATCH' // matches a blank template circulating online
  | 'SYNTHETIC_IMAGE' // generative-model detector
  | 'FONT_INCONSISTENCY' // substituted glyphs in the data fields
  | 'SECURITY_FEATURE_ABSENT' // expected hologram / seal not found
  // --- consistency (probabilistic, cross-document) -------------------------
  | 'NAME_MISMATCH' // ID name vs student card vs typed name
  | 'PORTRAIT_MISMATCH' // the two photos are different people
  | 'UNIVERSITY_MISMATCH' // card issuer vs selected university
  | 'CARD_EXPIRED'
  | 'ID_CHECKSUM_INVALID' // FIN fails its own check digit
  // --- quality (fixable, not fraud) ----------------------------------------
  | 'BLURRY'
  | 'GLARE'
  | 'LOW_RESOLUTION'
  | 'CROPPED_EDGES'
  | 'WRONG_DOCUMENT_TYPE';

export type SignalTier = 'INTEGRITY' | 'CONSISTENCY' | 'QUALITY';

export const SIGNAL_TIER: Record<SignalCode, SignalTier> = {
  SCREEN_RECAPTURE: 'INTEGRITY',
  DIGITAL_TAMPERING: 'INTEGRITY',
  EDITOR_METADATA: 'INTEGRITY',
  TEMPLATE_MATCH: 'INTEGRITY',
  SYNTHETIC_IMAGE: 'INTEGRITY',
  FONT_INCONSISTENCY: 'INTEGRITY',
  SECURITY_FEATURE_ABSENT: 'INTEGRITY',

  NAME_MISMATCH: 'CONSISTENCY',
  PORTRAIT_MISMATCH: 'CONSISTENCY',
  UNIVERSITY_MISMATCH: 'CONSISTENCY',
  CARD_EXPIRED: 'CONSISTENCY',
  ID_CHECKSUM_INVALID: 'CONSISTENCY',

  BLURRY: 'QUALITY',
  GLARE: 'QUALITY',
  LOW_RESOLUTION: 'QUALITY',
  CROPPED_EDGES: 'QUALITY',
  WRONG_DOCUMENT_TYPE: 'QUALITY',
};

/** Confidence penalty applied when a signal fires at full confidence. */
const WEIGHT: Partial<Record<SignalCode, number>> = {
  SCREEN_RECAPTURE: 0.45,
  DIGITAL_TAMPERING: 0.5,
  EDITOR_METADATA: 0.3,
  TEMPLATE_MATCH: 0.55,
  SYNTHETIC_IMAGE: 0.6,
  FONT_INCONSISTENCY: 0.35,
  SECURITY_FEATURE_ABSENT: 0.2,
  NAME_MISMATCH: 0.35,
  PORTRAIT_MISMATCH: 0.4,
  UNIVERSITY_MISMATCH: 0.25,
  CARD_EXPIRED: 0.15,
  ID_CHECKSUM_INVALID: 0.45,
};

export type Signal = { code: SignalCode; confidence: number; detail?: string };

export type Decision =
  | { outcome: 'VERIFIED'; confidence: number; codes: SignalCode[] }
  | { outcome: 'RETAKE'; confidence: number; codes: SignalCode[] }
  | { outcome: 'NEEDS_REVIEW'; confidence: number; codes: SignalCode[]; priority: number };

const AUTO_APPROVE = Number(process.env.VERIFY_AUTO_APPROVE_THRESHOLD ?? 0.88);
const SUSPICION_FLOOR = Number(process.env.VERIFY_SUSPICION_THRESHOLD ?? 0.35);
const CONFIDENCE_FLOOR = 0.55; // below this a signal is noise

/**
 * The single most important property of this function:
 *
 *   THERE IS NO 'BANNED' OUTCOME.
 *
 * The automated stage can approve, ask for a retake, or escalate to a human.
 * It cannot ban. Every ban on this platform is issued by a named moderator
 * through the admin panel, against a case they looked at, with a written
 * reason and an audit row.
 *
 * That is a hard requirement rather than a preference, for three reasons:
 *
 *  1. Legal. An automated ban is a decision with legal effect produced solely
 *     by automated processing. GDPR Art. 22 (and the equivalent provision in
 *     the AZ personal data law) gives the subject a right to human review, so
 *     a human has to be in the loop before the sanction, not after the appeal.
 *  2. Statistical. The strongest detector we have is moire-based screen
 *     recapture, and it fires on cheap phone cameras under the fluorescent
 *     lighting of a university library - which describes most of our users.
 *  3. Asymmetric cost. A false approval costs one moderation ticket, and is
 *     reversible. A false ban costs a student their account, their uploaded
 *     notes and their wallet balance, and there is no reversal path that
 *     scales.
 */
export function decide(input: {
  signals: Signal[];
  qualityScore: number; // 0..1, worst of the four documents
  attempt: number;
  maxAttempts: number;
}): Decision {
  const acted = input.signals.filter((s) => s.confidence >= CONFIDENCE_FLOOR);
  /**
   * De-duplicated: the verifier scores each of the four documents separately
   * and returns a signal per document, so a card that is blurry on both sides
   * yields BLURRY twice - up to four times across a submission.
   *
   * failureCodes is documented as a set of CATEGORIES ("SCREEN_RECAPTURE",
   * "NAME_MISMATCH"), not a per-document tally, and nothing reads the
   * multiplicity: the penalty below is computed from `acted` (the signal
   * objects, with their individual confidences) and the tier lookups use
   * find(). Storing the repeats only bloated the column and broke React keys
   * in the moderator queue, which is how this surfaced.
   */
  const codes = [...new Set(acted.map((s) => s.code))];

  const integrity = acted.filter((s) => SIGNAL_TIER[s.code] === 'INTEGRITY');
  const consistency = acted.filter((s) => SIGNAL_TIER[s.code] === 'CONSISTENCY');
  const quality = acted.filter((s) => SIGNAL_TIER[s.code] === 'QUALITY');

  const penalty = [...integrity, ...consistency].reduce(
    (sum, s) => sum + (WEIGHT[s.code] ?? 0.2) * s.confidence,
    0,
  );
  const confidence = clamp((1 - penalty) * (0.6 + 0.4 * clamp(input.qualityScore)));

  // 1. Unusable images and nothing suspicious -> ask for a retake.
  //    Deliberately does NOT consume an attempt: a blurry photo is not a fraud
  //    attempt, and burning attempts on blur only generates support tickets.
  if (integrity.length === 0 && consistency.length === 0 && quality.length > 0) {
    return { outcome: 'RETAKE', confidence, codes };
  }

  // 2. Clean and confident -> auto-verify.
  if (confidence >= AUTO_APPROVE && integrity.length === 0 && consistency.length === 0) {
    return { outcome: 'VERIFIED', confidence, codes };
  }

  // 3. Everything else is a human's call. Low confidence raises the queue
  //    priority; it never decides the outcome.
  return {
    outcome: 'NEEDS_REVIEW',
    confidence,
    codes,
    priority: reviewPriority({ confidence, integrity: integrity.length, attempt: input.attempt, maxAttempts: input.maxAttempts }),
  };
}

/** Higher sorts sooner in the moderator queue. */
function reviewPriority(input: {
  confidence: number;
  integrity: number;
  attempt: number;
  maxAttempts: number;
}): number {
  let priority = 0;
  if (input.confidence <= SUSPICION_FLOOR) priority += 50;
  priority += input.integrity * 15; // tampering signals jump the queue
  if (input.attempt >= input.maxAttempts) priority += 25; // last chance, unblock the user
  return priority;
}

/**
 * What the user is told.
 *
 * Quality feedback is specific, because it is the only feedback that helps an
 * honest user. Anything touching integrity or consistency collapses to one
 * generic string: naming the check that fired is free tuning feedback for
 * whoever is forging the document.
 */
export function publicMessageKey(decision: Decision): string {
  if (decision.outcome === 'VERIFIED') return 'verification.badge.verified';
  if (decision.outcome === 'NEEDS_REVIEW') return 'verification.banner.needsReview';

  const quality = decision.codes.find((c) => SIGNAL_TIER[c] === 'QUALITY');
  switch (quality) {
    case 'GLARE':
      return 'verification.quality.glare';
    case 'LOW_RESOLUTION':
      return 'verification.quality.tooSmall';
    case 'CROPPED_EDGES':
      return 'verification.quality.cropped';
    case 'WRONG_DOCUMENT_TYPE':
      return 'verification.quality.wrongFormat';
    default:
      return 'verification.quality.tooBlurry';
  }
}

/**
 * Per-check scores for the case row. Numbers only - the CHECK constraint in
 * 0002_zero_retention.sql rejects anything else, so this cannot become a
 * back door for retaining extracted text.
 */
export function toCheckScores(signals: Signal[], qualityScore: number): Record<string, number> {
  const scores: Record<string, number> = { quality: round3(qualityScore) };
  for (const signal of signals) {
    scores[signal.code.toLowerCase()] = round3(signal.confidence);
  }
  return scores;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
