import { NextResponse, type NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import {
  findUserByEmail,
  getCredentials,
  incrementFailedLogins,
  updateCredentials,
  updateUser,
} from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { loginSchema } from '@/server/validators/auth';
import { burnPasswordTime, hashPassword, verifyPassword } from '@/lib/crypto/hash';
import { rateLimit, peekRateLimit, resetRateLimit, clientIp } from '@/lib/security/ratelimit';
import { isUserBlocked, recordDeviceDetailed } from '@/lib/security/blocklist';
import { sendEmailAsync } from '@/lib/email/send';
import { deviceLabel } from '@/lib/security/fingerprint';
import { issueSession } from '@/lib/auth/session';

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
  const { email, password, deviceFingerprint } = parsed.data;

  /**
   * The per-(address + email) budget. Checked, not consumed: a token is spent
   * only when an attempt actually FAILS, further down. Charging on the way in
   * meant a correct password cost the same as a wrong one, so five ordinary
   * sign-ins locked the account out for fifteen minutes.
   */
  const identity = { ip, subject: email };
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
  const user = await findUserByEmail(email);
  const credential = user ? await getCredentials(user.id) : null;

  // No such user. Burn comparable time, then answer identically.
  if (!user || user.deletedAt || !credential) {
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

  // --- success -------------------------------------------------------------

  /**
   * Proving you own the account clears the attempt budget, the same way the
   * update below clears failedLoginCount and lockedUntil. Only the address-wide
   * ceiling is left alone: a successful sign-in is not evidence that the other
   * ninety attempts from that address were legitimate.
   */
  await resetRateLimit('auth:login', identity);

  // Opportunistic rehash: bcrypt hashes upgrade to argon2id on the one
  // occasion we legitimately hold the plaintext. No migration, no forced reset.
  const passwordHash = check.needsRehash ? await hashPassword(password) : undefined;

  await updateUser(user.id, {
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: new Date(),
  });
  // The rehash lands in the credential document, never on the profile.
  if (passwordHash) await updateCredentials(user.id, { passwordHash });

  const device = deviceFingerprint
    ? await recordDeviceDetailed({
        userId: user.id,
        fingerprint: deviceFingerprint,
        label: deviceLabel(request.headers.get('user-agent') ?? undefined),
      })
    : undefined;
  const deviceId = device?.id;

  // First sign-in from this device (registration records the device it was
  // created on, so a normal login there is not "new").
  if (device?.created) {
    sendEmailAsync(user.email, 'newDeviceLogin', {
      nickname: user.nickname,
      device: deviceLabel(request.headers.get('user-agent') ?? undefined),
      when: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    });
  }

  const session = await issueSession({
    user: {
      id: user.id,
      role: user.role,
      accountStatus: user.accountStatus,
      verificationStatus: user.verificationStatus,
    },
    userAgent: request.headers.get('user-agent') ?? '',
    deviceId,
  });

  await writeAuditLog({
    actorId: user.id,
    action: 'USER_LOGIN',
    entityType: 'user',
    entityId: user.id,
    deviceFingerprint,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result: 'SUCCESS',
  });

  /**
   * Where this account belongs after signing in, decided HERE rather than on
   * the client.
   *
   * The access token deliberately carries no role claim - see issueSession -
   * so the browser has no way to know whether it just signed in a student or
   * an administrator. The form previously had no information to act on and
   * simply pushed everyone to /dashboard, which is why staff landed on the
   * student feed and had to retype the URL.
   *
   * Returning a destination keeps the role server-side and read from live
   * state, and it matches what /api/auth/register already does with
   * `next: { step, href }`. The client treats this as a default, not as
   * authorization: /admin is still guarded by its own layout and by every
   * /api/admin handler, so a tampered response changes where a browser
   * navigates and nothing about what it may read.
   *
   * MODERATOR lands here too - the panel is where their work is, and
   * requireAdmin admits them at the MODERATOR tier.
   */
  const isStaff = user.role === UserRole.ADMIN || user.role === UserRole.MODERATOR;

  const response = NextResponse.json({
    user: { id: user.id, role: user.role, verificationStatus: user.verificationStatus },
    next: { href: isStaff ? '/admin' : '/dashboard' },
  });
  session.applyCookies(response);
  return response;
}
