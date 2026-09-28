import { NextResponse, type NextRequest } from 'next/server';
import { UserRole, VerificationStatus } from '@/lib/enums';
import {
  createUser,
  newUserDefaults,
  newUserId,
  DuplicateUserError,
  type ConflictField,
} from '@/lib/firebase/repositories/users';
import { findUniversityByCode } from '@/lib/firebase/repositories/reference';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { mentorRegisterSchema, registerSchema, splitFullName } from '@/server/validators/auth';
import { hashPassword, hashEmail, hashPhone } from '@/lib/crypto/hash';
import { checkSignupBlocked, recordDevice } from '@/lib/security/blocklist';
import { deviceLabel } from '@/lib/security/fingerprint';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { issueSession, sessionClientOf } from '@/lib/auth/session';
import { sendEmailAsync } from '@/lib/email/send';
import { sendVerificationEmail } from '@/lib/auth/email-verification';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';

/**
 * Password registration, shared by the two signup endpoints:
 *
 *   POST /api/auth/register         student  - /register
 *   POST /api/auth/register/mentor  mentor   - /mentors/join
 *
 * One implementation so the two cannot drift: the rate limit, the
 * credentials-in-URL guard, the blocklist, the one-transaction account write,
 * the device record and the session are identical. The track decides only the
 * schema (a mentor's university is optional), the role, `mentorSince` and
 * where the client is sent next. It is chosen by the ENDPOINT, never by a
 * body field - registerSchema strips unknown keys precisely so a client cannot
 * pick its own role.
 */
export type SignupTrack = 'student' | 'mentor';

/**
 * The message each clashing field gets.
 *
 * Every key already exists in messages/{az,en,ru}.json - they were written for
 * this and then never reached, because the route collapsed email and phone
 * into one shared string before the client could tell them apart.
 */
const CONFLICT_MESSAGES: Record<ConflictField, string> = {
  email: 'auth.errors.emailTaken',
  phone: 'auth.errors.phoneTaken',
  nickname: 'auth.errors.nicknameTaken',
  // A provider identity clash has no field on this form.
  identity: 'auth.errors.credentialsUnavailable',
};

/**
 * Whether email and phone clashes are reported SEPARATELY.
 *
 * Separate is the default, because the bundled message was unusable: told only
 * "these details cannot be used", someone whose phone was the problem edits
 * their email, resubmits, and gets the same sentence back. That is a dead end
 * on the first screen of the product.
 *
 * The cost is stated plainly: a distinct "that number is already in use" makes
 * signup an enumeration oracle for phone numbers as well as addresses, and SIM
 * registration in Azerbaijan is identity-linked, so a number is the more
 * sensitive of the two. What limits it is the rate limiter on this route
 * (auth:register, keyed by IP) - a bound on volume, not a fix.
 *
 * Set AUTH_COLLAPSE_SIGNUP_CONFLICTS=true to restore the shared message
 * without a code change. The real answer to the oracle is the deferred
 * verification flow described in the catch block below.
 */
const COLLAPSE_CONFLICTS = process.env.AUTH_COLLAPSE_SIGNUP_CONFLICTS === 'true';

/**
 * Turns a clash into ONE message per offending field, in the `fields` shape
 * the 400 validation response already uses - so the client has a single code
 * path for "these named fields are wrong" and does not have to infer a field
 * from a top-level error string.
 */
function conflictResponse(error: DuplicateUserError) {
  const collapsible = new Set<string>(error.fields.filter((f) => f === 'email' || f === 'phone'));
  const fields: Record<string, string[]> = {};

  for (const field of error.fields) {
    if (field === 'identity') continue;
    fields[field] =
      COLLAPSE_CONFLICTS && collapsible.has(field)
        ? ['auth.errors.credentialsUnavailable']
        : [CONFLICT_MESSAGES[field]];
  }

  /**
   * When email or phone clash and we are collapsing, BOTH fields carry the
   * shared message even if only one actually matched - which is the whole
   * point of collapsing: the response must not say which.
   */
  if (COLLAPSE_CONFLICTS && collapsible.size > 0) {
    fields.email = ['auth.errors.credentialsUnavailable'];
    fields.phone = ['auth.errors.credentialsUnavailable'];
  }

  return {
    // Kept for older clients that only read `error`. The first clash in form
    // order, which is what a single-message client would have shown anyway.
    error: COLLAPSE_CONFLICTS && collapsible.has(error.field)
      ? 'auth.errors.credentialsUnavailable'
      : CONFLICT_MESSAGES[error.field],
    fields,
  };
}

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
 * Next.js already answers 405 for an unexported method, but stating it in each
 * route makes the constraint reviewable there and guarantees the endpoint can
 * never be reached by a shape - a link, a redirect, a prefetch, an <img src> -
 * that would put credentials in a URL. Cache-Control stops any intermediary
 * from retaining the response to such an attempt.
 */
export function signupMethodNotAllowed() {
  return NextResponse.json(
    { error: 'errors.methodNotAllowed' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}

/**
 * Single-step registration. Creates the account and signs the user in
 * immediately with verificationStatus = UNVERIFIED; identity documents are a
 * separate, later step at /verify.
 */
export async function passwordSignup(request: NextRequest, track: SignupTrack): Promise<NextResponse> {
  const ip = clientIp(request.headers);

  // One bucket for both tracks: a second endpoint must not double the
  // signups an address can make per hour.
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

  const parsed = (track === 'mentor' ? mentorRegisterSchema : registerSchema).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const email = input.email;

  // Blocklist check before any write. A banned identity gets the same generic
  // response as a duplicate email - telling someone *which* rule caught them
  // is free tuning information.
  const blocked = await checkSignupBlocked({
    email,
    phone: input.phone,
    deviceFingerprint: input.deviceFingerprint,
  });
  if (blocked.blocked) {
    return NextResponse.json({ error: 'verification.failure.generic' }, { status: 403 });
  }

  // Looked up by `code`, which is what the form submits; `university.id` below
  // is the document id the user record actually stores. Only a mentor may
  // leave it out, and the schema has already enforced that.
  const university = input.universityId ? await findUniversityByCode(input.universityId) : null;
  if (input.universityId && !university) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: { universityId: ['errors.fieldRequired'] } },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(input.password);
  const { firstName, lastName } = splitFullName(input.fullName);
  const now = new Date();
  const isMentor = track === 'mentor';

  try {
    /**
     * The id is reserved BEFORE the write, so the audit entry below can
     * reference it without a second round trip.
     */
    const userId = newUserId();

    /**
     * Profile + credentials in ONE transaction (createUser): a profile without
     * its credential document is an account nobody can log into, and the
     * reverse is an orphaned password hash.
     */
    const user = await createUser({
      profile: {
        ...newUserDefaults(),
        id: userId,
        // Lowercased by the schema: Firestore equality is case-sensitive and
        // findUserByEmail queries the lowercase form.
        email,
        emailVerifiedAt: null,
        // E.164 by the time it gets here - registerSchema normalised it.
        // Stored unverified: possession is proven separately, and until then
        // `phoneVerifiedAt` (null, from newUserDefaults) is what says so.
        phone: input.phone,
        fullName: input.fullName,
        firstName,
        lastName,
        /**
         * A mentor account is the same user document as a student's; the role
         * is what differs, and with it what can() grants. The join date is the
         * signup itself - it anchors the monthly fee reminder on the mentor
         * panel (src/lib/mentors/billing.ts).
         */
        role: isMentor ? UserRole.MENTOR : UserRole.STUDENT,
        mentorSince: isMentor ? now : null,
        nickname: input.nickname,
        locale: input.locale,
        universityId: university?.id ?? null,
        verificationStatus: VerificationStatus.UNVERIFIED,
        createdAt: now,
        updatedAt: now,
      },
      /**
       * The password hash and the email HMAC go to `credentials/{userId}`,
       * never onto the user document - that collection is denied to every
       * client in firestore.rules.
       */
      /**
       * The phone HMAC sits beside the email one, and it is what makes
       * createUser's phone uniqueness check fire at all: that check is guarded
       * by `if (creds.phoneHash)`, so passing null - as this route used to -
       * silently skipped it and let one number back as many accounts as it
       * liked.
       */
      credentials: {
        passwordHash,
        emailHash: hashEmail(email),
        phoneHash: hashPhone(input.phone),
      },
    });

    /**
     * The audit entry is written AFTER the transaction, not inside it: a
     * Firestore transaction must do all its reads before any write, and
     * createUser's uniqueness checks are reads. A missing audit row for a
     * registration is visible in the record the registration itself creates;
     * profile-and-credentials, which must not be split, stayed inside.
     */
    await writeAuditLog({
      actorId: user.id,
      action: 'USER_REGISTERED',
      entityType: 'user',
      entityId: user.id,
      deviceFingerprint: input.deviceFingerprint,
      userAgent: request.headers.get('user-agent')?.slice(0, 512),
      after: { method: 'password', track },
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
      // A brand-new account has proven one factor: its password.
      amr: ['pwd'],
      mfaAt: null,
      client: sessionClientOf(request.cookies),
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
        faculty: null,
      },
      { dedupeKey: `welcome:${user.id}` },
    );

    // A confirmation link for the address. Failure to send must not fail the
    // registration: the account can request another from Settings -> Security.
    await sendVerificationEmail(user).catch(() => {});

    /**
     * 201 with the next step spelled out, so the client does not have to
     * hard-code the funnel order. A mentor goes to the mentor panel, whose
     * checklist carries the rest of the funnel (verify, apply, approval).
     */
    const response = NextResponse.json(
      {
        user: { id: user.id, role: user.role, verificationStatus: user.verificationStatus },
        next: isMentor
          ? { step: 'MENTOR_DASHBOARD', href: MENTOR_DASHBOARD_PATH }
          : { step: 'VERIFY_DOCUMENTS', href: '/verify' },
      },
      { status: 201 },
    );
    session.applyCookies(response);
    return response;
  } catch (error) {
    /**
     * Unique violation, reported PER FIELD.
     *
     * createUser() now runs every uniqueness check before throwing, so
     * `error.fields` is the complete list rather than whichever check happened
     * to fail first. Someone whose email and phone are both taken is told so
     * once, instead of discovering the second one on a resubmit.
     *
     * NICKNAME is named explicitly and always has been: a handle is public by
     * design - it renders in the feed, on note listings and in mentor reviews
     * - so "that handle is taken" leaks nothing you could not learn by
     * scrolling, and the user cannot pick another unless we say so.
     *
     * EMAIL and PHONE are named too, by default. See COLLAPSE_CONFLICTS above
     * for the enumeration trade-off and the switch that reverses it.
     *
     * The oracle is not closed by either setting. Closing it needs the
     * deferred-verification flow: always answer 201, create nothing, and email
     * the address either a verification link (new) or a "someone tried to sign
     * up as you" notice (existing). That needs working mail delivery, so it is
     * deliberately not done here.
     */
    if (error instanceof DuplicateUserError) {
      return NextResponse.json(conflictResponse(error), { status: 409 });
    }
    throw error;
  }
}
