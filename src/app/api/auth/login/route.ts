import { NextResponse, type NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import {
  findUserByEmail,
  findUserByUsername,
  getCredentials,
  incrementFailedLogins,
  updateCredentials,
  updateUser,
} from '@/lib/firebase/repositories/users';
import { createLoginTicket, getMfa, isEnrolled } from '@/lib/firebase/repositories/mfa';
import { loginSchema } from '@/server/validators/auth';
import { burnPasswordTime, hashPassword, verifyPassword } from '@/lib/crypto/hash';
import { rateLimit, peekRateLimit, resetRateLimit, clientIp } from '@/lib/security/ratelimit';
import { isUserBlocked } from '@/lib/security/blocklist';
import { completeLogin } from '@/lib/auth/complete-login';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login
 *
 * ---------------------------------------------------------------------------
 * ONE ERROR MESSAGE, ALWAYS
 * ---------------------------------------------------------------------------
 * Every failure path below returns the SAME body:
 *
 *   { error: 'auth.errors.invalidCredentials' }
 *   -> "İstifadəçi adı (e-poçt) və ya şifrə yanlışdır"
 *
 * That is not laziness, it is the whole point. Distinguishing "no such email"
 * from "wrong password" turns the login form into an account-enumeration
 * oracle: an attacker feeds it a breach list and learns which addresses are
 * registered here, then targets those people with credential stuffing or a
 * convincing phish. On a platform where the user base is a known population -
 * students at eighteen named universities - that list is unusually valuable.
 *
 * The same rule covers the less obvious cases:
 *  - locked account -> same message (otherwise you can enumerate by lockout)
 *  - banned account -> same message
 *  - unverified email -> same message
 *
 * ---------------------------------------------------------------------------
 * TIMING IS PART OF THE MESSAGE
 * ---------------------------------------------------------------------------
 * Returning identical TEXT while returning it in 2ms for an unknown address
 * and 60ms for a known one leaks exactly the same information, just through a
 * side channel. `burnPasswordTime()` runs a real Argon2 verification against a
 * dummy hash whenever there is no user to check, so both paths cost the same.
 */
const GENERIC_FAILURE = { error: 'auth.errors.invalidCredentials' } as const;
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);

  /**
   * The address-wide ceiling is checked before the body is even parsed, since
   * it is the only limit that can be evaluated without knowing which account
   * is being targeted. It is deliberately generous - it exists to stop a
   * scripted run across many emails, not to police one person's typing.
   */
  const ipLimit = await peekRateLimit('auth:login:ip', { ip });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSeconds) } },
    );
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // Even a malformed body gets the generic message rather than a field-level
    // validation dump, which would confirm the email format was at least valid.
    await burnPasswordTime();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }
  const { identifier, password, deviceFingerprint } = parsed.data;

  /**
   * The per-(address + identifier) budget. Checked, not consumed: a token is
   * spent only when an attempt actually FAILS, further down. Charging on the
   * way in meant a correct password cost the same as a wrong one, so five
   * ordinary sign-ins locked the account out for fifteen minutes.
   *
   * The subject is the identifier AS TYPED (normalised), never the resolved
   * user id. Keying on the account would be tighter, but it would also be an
   * oracle: a real account reached by both its email and its @handle would
   * share one bucket and hit 429 sooner than a made-up pair, which tells an
   * attacker the two belong together. Per-ACCOUNT protection is the
   * failedLoginCount lockout below, which counts every failure against the
   * user whichever form reached it - so two identifiers do not buy an
   * attacker two budgets there. An email subject stays the bare address, so
   * existing buckets carry over; "@" can never start an email, so the two
   * forms cannot collide.
   */
  const subject = identifier.kind === 'email' ? identifier.value : `@${identifier.value}`;
  const identity = { ip, subject };
  const attemptLimit = await peekRateLimit('auth:login', identity);
  if (!attemptLimit.ok) {
    await burnPasswordTime();
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(attemptLimit.retryAfterSeconds) } },
    );
  }

  /**
   * Charges one failed attempt against both buckets. Every path that answers
   * with GENERIC_FAILURE goes through here, so "wrong password", "no such
   * user" and "banned account" all cost exactly the same - a limiter that
   * charged only real accounts would itself become an enumeration oracle.
   */
  const chargeFailure = async () => {
    await Promise.all([
      rateLimit('auth:login', identity),
      rateLimit('auth:login:ip', { ip }),
    ]);
  };

  /**
   * Profile and credential are two reads, by design.
   *
   * The argon2id hash lives in `credentials/{userId}`, not on the user
   * document, because Firestore grants are per-document: a rule permitting
   * "read your own profile" would otherwise hand out the password hash with
   * it. See the header of the users repository.
   *
   * The hash is still argon2id and is still verified by this application -
   * Firebase Auth cannot check argon2, and re-hashing everyone with something
   * it can would be a silent downgrade.
   */
  const found =
    identifier.kind === 'email'
      ? await findUserByEmail(identifier.value)
      : await findUserByUsername(identifier.value);

  /**
   * STAFF SIGN IN BY EMAIL ONLY.
   *
   * A username is public: it is printed next to every post, note and review.
   * An email is not. For an ordinary account that difference barely matters,
   * but for ADMIN and MODERATOR it removes half of what an attacker has to
   * know - and the bootstrap admin's handle is literally "admin". Two things
   * follow from refusing the handle here:
   *
   *  - Guessing a staff password requires first learning a private address.
   *  - Nobody can lock staff out of the panel by hammering a public name,
   *    because this path never reaches the failedLoginCount increment below.
   *
   * The account is treated exactly as if it did not exist - same body, same
   * Argon2 cost, same rate-limit charge - so this cannot be used to discover
   * which handles belong to staff.
   */
  const staffViaUsername =
    identifier.kind === 'username' &&
    !!found &&
    (found.role === UserRole.ADMIN || found.role === UserRole.MODERATOR);
  const user = staffViaUsername ? null : found;
  const credential = user ? await getCredentials(user.id) : null;

  // No such user. Burn comparable time, then answer identically. An account
  // with no password (a future social-only or phone-only sign-up) cannot be
  // entered through this route and is indistinguishable from a missing one.
  if (!user || user.deletedAt || !credential || typeof credential.passwordHash !== 'string') {
    await burnPasswordTime();
    await chargeFailure();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  // Locked out. Same message - "this account is locked" is itself a
  // confirmation that the account exists.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await burnPasswordTime();
    await chargeFailure();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  const check = await verifyPassword(password, credential.passwordHash);

  if (!check.valid) {
    const nextCount = user.failedLoginCount + 1;
    // An atomic increment rather than a read-modify-write: two simultaneous
    // wrong guesses must both count, or the lockout can be outrun.
    await incrementFailedLogins(
      user.id,
      nextCount >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
        : null,
    );
    await chargeFailure();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  // Password is correct, but the account may still not be usable. Banned and
  // blocked accounts get the SAME message - telling someone "your account is
  // banned" confirms both that it exists and that their password was right,
  // which is precisely what a credential-stuffer wants to learn.
  if (user.accountStatus === 'BANNED' || user.accountStatus === 'DELETED') {
    await chargeFailure();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }
  if (await isUserBlocked(user.id)) {
    await chargeFailure();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  // --- password accepted --------------------------------------------------

  /**
   * Proving you own the account clears the attempt budget. Only the
   * address-wide ceiling is left alone: a successful sign-in is not evidence
   * that the other ninety attempts from that address were legitimate.
   *
   * The failed-login counter is reset here too, and NOT only once a session
   * exists: the password was right, so the password lockout has done its job
   * whether or not a second factor follows. The second factor has its own
   * counter and lockout (repositories/mfa.ts).
   */
  await resetRateLimit('auth:login', identity);
  await updateUser(user.id, { failedLoginCount: 0, lockedUntil: null });

  // Opportunistic rehash: bcrypt hashes upgrade to argon2id on the one
  // occasion we legitimately hold the plaintext. No migration, no forced reset.
  // The rehash lands in the credential document, never on the profile.
  if (check.needsRehash) await updateCredentials(user.id, { passwordHash: await hashPassword(password) });

  const method = identifier.kind === 'email' ? 'email_password' : 'username_password';

  /**
   * SECOND FACTOR.
   *
   * An enrolled account gets a login ticket, not a session. This branch is
   * reached only AFTER the password verified and every status check passed,
   * so "this account has 2FA" is never disclosed to someone who does not
   * already hold the password - the response for a wrong password is the
   * generic 401 above, whatever the account's 2FA state.
   *
   * No device is recorded, no new-device email is sent and lastLoginAt is not
   * touched: none of that has happened until the second factor succeeds.
   */
  const mfa = await getMfa(user.id);
  if (isEnrolled(mfa)) {
    const ticket = await createLoginTicket({
      userId: user.id,
      userAgent: request.headers.get('user-agent') ?? '',
      deviceFingerprint,
      amr: ['pwd'],
    });
    return NextResponse.json({
      mfaRequired: true,
      ticket: ticket.token,
      expiresAt: ticket.expiresAt.toISOString(),
      method,
    });
  }

  return completeLogin({ request, user, deviceFingerprint, amr: ['pwd'], mfaAt: null, method });
}
