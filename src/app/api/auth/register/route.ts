import { NextResponse, type NextRequest } from 'next/server';
import { UserRole, VerificationStatus } from '@/lib/enums';
import {
  createUser,
  newUserDefaults,
  newUserId,
  DuplicateUserError,
} from '@/lib/firebase/repositories/users';
import { findUniversityByCode } from '@/lib/firebase/repositories/reference';
import { ensureWallet } from '@/lib/firebase/repositories/wallets';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { registerSchema } from '@/server/validators/auth';
import { hashPassword, hashEmail, hashPhone } from '@/lib/crypto/hash';
import { checkSignupBlocked, recordDevice } from '@/lib/security/blocklist';
import { deviceLabel } from '@/lib/security/fingerprint';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { issueSession } from '@/lib/auth/session';
import { sendEmailAsync } from '@/lib/email/send';
import { FACULTY_OTHER, facultyLabel } from '@/lib/faculties';

export const runtime = 'nodejs';

/**
 * Field names that must never appear in a query string. Both our canonical
 * schema keys and the HTML name=/autocomplete= tokens the browser would emit
 * on a native GET submit ('new-password', 'tel', 'username'), since the whole
 * point is to catch the submission shape we do NOT control.
 */
const CREDENTIAL_QUERY_KEYS = new Set([
  'password', 'passwordconfirm', 'new-password', 'current-password',
  'email', 'phone', 'tel', 'nickname', 'username', 'fullname', 'name',
]);

/**
 * Registration is POST-only, and the 405 is explicit rather than implied.
 *
 * Next.js already answers 405 for an unexported method, but stating it here
 * makes the constraint reviewable in this file and guarantees the endpoint can
 * never be reached by a shape - a link, a redirect, a prefetch, an <img src> -
 * that would put credentials in a URL. Cache-Control stops any intermediary
 * from retaining the response to such an attempt.
 */
export async function GET() {
  return NextResponse.json(
    { error: 'errors.methodNotAllowed' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}

export const HEAD = GET;

/**
 * POST /api/auth/register  -  Step 1 of the funnel.
 *
 * Creates the account and signs the user in immediately with
 * verificationStatus = UNVERIFIED. Document upload is a separate step so a
 * dropped connection during a 12 MB upload does not lose the account, and so
 * the user is never staring at a spinner while a model runs.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);

  const limit = await rateLimit('auth:register', { ip });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  /**
   * The body is the ONLY accepted channel for credentials.
   *
   * If this request arrived carrying registration fields in its query string,
   * something upstream has already leaked them - into history, access logs and
   * the Referer header - before we ever saw it. We refuse rather than quietly
   * succeeding, because a 201 here would teach a client that the unsafe shape
   * works and let the leak harden into a supported path. We deliberately do
   * not echo the offending key back: it would copy the secret into our own
   * error logs, which is the exact thing being prevented.
   */
  const leakedParams = [...request.nextUrl.searchParams.keys()].filter((key) =>
    CREDENTIAL_QUERY_KEYS.has(key.toLowerCase()),
  );
  if (leakedParams.length > 0) {
    return NextResponse.json(
      { error: 'errors.credentialsInQueryString' },
      { status: 400 },
    );
  }

  // Reject urlencoded/multipart submissions outright. A native browser form
  // POST would arrive as application/x-www-form-urlencoded; accepting it would
  // mean supporting a path whose GET twin is the vulnerability we just closed.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return NextResponse.json({ error: 'errors.unsupportedMediaType' }, { status: 415 });
  }

  // A malformed body must be a 400, not an unhandled throw that becomes a 500
  // and a stack trace in the logs.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Blocklist check before any write. A banned identity gets the same generic
  // response as a duplicate email - telling someone *which* rule caught them
  // is free tuning information.
  const blocked = await checkSignupBlocked({
    email: input.email,
    phone: input.phone,
    deviceFingerprint: input.deviceFingerprint,
  });
  if (blocked.blocked) {
    return NextResponse.json({ error: 'verification.failure.generic' }, { status: 403 });
  }

  // Looked up by `code`, which is what the form submits; `university.id` below
  // is the document id the user record actually stores. Absent only for a
  // MENTOR (the schema requires it of a student); a code that was SENT must
  // still resolve to a real, seeded university.
  const university = input.universityId ? await findUniversityByCode(input.universityId) : null;
  if (input.universityId && !university) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const passwordHash = await hashPassword(input.password);

  /**
   * ---------------------------------------------------------------------------
   * "GRADUATED" IS A ROLE, NOT A FLAG
   * ---------------------------------------------------------------------------
   * The account type answers "student or mentor"; academicStatus answers "are
   * you still there". Someone who registers as a student and says they have
   * already graduated IS an alumnus, and writing them as STUDENT would leave
   * the product lying about them in three places at once:
   *
   *   - verification would demand a current student card they do not hold
   *     (requiredKindsFor() branches on the role, and ALUMNI is identity-only);
   *   - the 1 May graduation sweep would prompt them to "switch to alumni"
   *     for a transition that already happened;
   *   - the profile would show "Verified student" over a date in the past.
   *
   * ALUMNI is absent from ACCOUNT_TYPES on purpose - it is not a thing a
   * stranger claims at signup, it is a thing the server concludes. This is the
   * one place it concludes it, from a validated pair the schema has already
   * checked for internal agreement.
   *
   * alumniTransitionedAt is stamped for the same reason: the sweep skips
   * anyone who already carries it, so without it the first 1 May after signup
   * would prompt a fresh alumni account to become alumni.
   */
  const graduated = input.accountType === UserRole.STUDENT && input.academicStatus === 'GRADUATED';
  const role = graduated ? UserRole.ALUMNI : input.accountType;

  try {
    /**
     * The id is reserved BEFORE the write.
     *
     * Under Postgres the cuid was generated by the insert, so nothing could
     * reference the user until the row existed. Firestore lets us allocate the
     * document id up front, which is what makes the wallet and the audit entry
     * below possible without a second round trip to discover the id.
     */
    const userId = newUserId();

    /**
     * Creation is one Firestore TRANSACTION covering the profile and the
     * credentials, which is the part that has to be atomic: a profile without
     * its credential document is an account nobody can ever log into, and a
     * credential document without its profile is an orphaned password hash.
     *
     * The wallet and the audit entry are deliberately OUTSIDE it - see below.
     */
    const user = await createUser({
      profile: {
        // Everything Postgres used to default. Stated first so the explicit
        // fields below always win; see newUserDefaults() for why this matters.
        ...newUserDefaults(),
        id: userId,
        // Lowercased on the way in: `findUserByEmail` queries the lowercase
        // form, and Firestore's equality match is case-sensitive, so a
        // capitalised address stored verbatim would be unfindable at login.
        email: input.email.toLowerCase(),
        /**
         * fullName is DERIVED from the two halves rather than trusted from
         * the client, so the denormalised value can never disagree with the
         * structured one it is supposed to summarise. `input.fullName` is
         * still accepted for older clients and used only as a fallback.
         */
        fullName: `${input.firstName} ${input.lastName}`.trim() || input.fullName || '',
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        /**
         * The account type IS the role. There is no separate accountType
         * field - see the note in the schema for why a parallel field would
         * be a duplicate concept. The one transformation is GRADUATED, which
         * resolves to ALUMNI; see the block above.
         */
        role,
        nickname: input.nickname,
        locale: input.locale,
        universityId: university?.id ?? null,
        facultyId: input.facultyId ?? null,
        // Type-specific. Each is null on the branch it does not belong to, and
        // the schema has already refused a request that omitted one its
        // account type requires.
        studentNumber: input.studentNumber ?? null,
        department: input.department ?? null,
        academicTitle: input.academicTitle ?? null,
        facultySlug: input.facultySlug ?? null,
        // Cleared unless the choice was 'other', matching the CHECK constraint
        // Postgres enforced. Firestore cannot enforce it, so the pairing is
        // maintained here, at the single point where it is written.
        facultyOther: input.facultySlug === FACULTY_OTHER ? input.facultyOther ?? null : null,
        graduationYear: input.graduationYear ?? null,
        graduationMonth: input.graduationMonth ?? null,
        // MENTOR only (the schema refuses it elsewhere): the schedule chosen
        // in the wizard, kept as a draft that prefills /mentors/apply. The
        // profile timezone follows it so the two cannot disagree.
        mentorAvailability: input.availability ?? null,
        ...(input.timezone ? { timezone: input.timezone } : {}),
        // Already an alumnus at signup: stamped so the 1 May sweep does not
        // prompt them to make a transition that is already recorded.
        alumniTransitionedAt: graduated ? new Date() : null,
        verificationStatus: VerificationStatus.UNVERIFIED,
        phone: input.phone ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      /**
       * The password hash and the PII HMACs go to `credentials/{userId}`,
       * NOT onto the user document. Firestore grants are per document, so this
       * separate collection - denied to every client in firestore.rules - is
       * the only way to keep "a user may read their own profile" from also
       * meaning "may read their own argon2id hash".
       *
       * The hash is still argon2id, produced by the same hashPassword() as
       * before. Nothing about password handling was weakened by the move.
       */
      credentials: {
        passwordHash,
        emailHash: hashEmail(input.email),
        phoneHash: input.phone ? hashPhone(input.phone) : null,
      },
    });

    /**
     * The wallet and the audit entry are written AFTER the transaction, not
     * inside it, and that is a deliberate change from the SQL version.
     *
     * A Firestore transaction must do all its reads before any write, and
     * createUser's uniqueness checks are reads. Folding two more writes in
     * would mean either passing the transaction handle across three module
     * boundaries - so those repositories could no longer be called normally -
     * or re-implementing them inline.
     *
     * The trade is acceptable because BOTH are recoverable and neither is a
     * credential:
     *   - ensureWallet() is idempotent and creates a zero-balance wallet, so a
     *     crash between the two leaves an account whose next wallet read can
     *     safely create it. No money can be lost, because there is none yet.
     *   - a missing audit row for a registration is visible in the record the
     *     registration itself creates.
     * What must NOT be split is profile-and-credentials, and that is exactly
     * what stayed inside the transaction.
     */
    await ensureWallet(user.id);

    await writeAuditLog({
      actorId: user.id,
      action: 'USER_REGISTERED',
      entityType: 'user',
      entityId: user.id,
      deviceFingerprint: input.deviceFingerprint,
      userAgent: request.headers.get('user-agent')?.slice(0, 512),
    });

    // Record the device before the session so the session can reference it.
    // This is the replacement for logging a signup IP: it is what a later ban
    // attaches to, and unlike an address it does not implicate a whole dorm.
    const deviceId = input.deviceFingerprint
      ? await recordDevice({
          userId: user.id,
          fingerprint: input.deviceFingerprint,
          label: deviceLabel(request.headers.get('user-agent') ?? undefined),
        })
      : undefined;

    const session = await issueSession({
      user,
      userAgent: request.headers.get('user-agent') ?? '',
      deviceId,
    });

    /**
     * The welcome email, sent AFTER the transaction has committed.
     *
     * Fire-and-forget by design: sendEmail never throws and never rejects (see
     * src/lib/email/send.ts), so a provider outage cannot turn a successful
     * registration into a 500. Mailing from inside the transaction would be
     * the classic version of this bug - the message goes out, the transaction
     * then rolls back, and the user holds a welcome for an account that does
     * not exist.
     *
     * The message contains no password and no credential of any kind.
     */
    sendEmailAsync(
      user.email,
      'welcome',
      {
        nickname: user.nickname,
        university: university?.nameEn ?? null,
        faculty: facultyLabel(input.facultySlug ?? null, input.facultyOther ?? null),
      },
      { dedupeKey: `welcome:${user.id}` },
    );

    // 201 with the next step spelled out, so the client does not have to
    // hard-code the funnel order.
    const response = NextResponse.json(
      {
        user: { id: user.id, verificationStatus: user.verificationStatus },
        next: { step: 'VERIFY_DOCUMENTS', href: '/verify' },
      },
      { status: 201 },
    );
    session.applyCookies(response);
    return response;
  } catch (error) {
    /**
     * Unique violation. Which field clashed determines what we may say.
     *
     * NICKNAME -> named explicitly. A nickname is public by design: it renders
     * in the feed, on note listings and in mentor reviews, so "that handle is
     * taken" leaks nothing you could not learn by scrolling. And the user
     * cannot pick a different one unless we tell them.
     *
     * EMAIL or PHONE -> collapsed into ONE shared message. Distinguishing them
     * turns signup into a two-field enumeration oracle: an attacker learns
     * both which addresses AND which phone numbers already have accounts here.
     * Phone is the more sensitive of the two, because SIM registration in
     * Azerbaijan is identity-linked.
     *
     * HONEST LIMITATION: this halves the oracle's precision but does not
     * remove it - the caller still learns that *one of* the two is in use.
     * Fully closing it needs the deferred-verification flow: always answer
     * 201, create nothing, and email the address either a verification link
     * (new) or a "someone tried to sign up as you" notice (existing). That
     * needs working mail delivery, so it is deliberately not done here.
     */
    if (error instanceof DuplicateUserError) {
      const key =
        error.field === 'nickname'
          ? 'auth.errors.nicknameTaken'
          : 'auth.errors.credentialsUnavailable';
      return NextResponse.json({ error: key }, { status: 409 });
    }
    throw error;
  }
}
