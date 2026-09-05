import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { loginSchema } from '@/server/validators/auth';
import { burnPasswordTime, hashPassword, verifyPassword } from '@/lib/crypto/hash';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { isUserBlocked, recordDevice } from '@/lib/security/blocklist';
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

  // Rate limit first: 5 attempts / 15 min. This is the control that actually
  // stops credential stuffing; the generic message only stops enumeration.
  const limit = await rateLimit('auth:login', { ip });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
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

  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      passwordHash: true,
      role: true,
      accountStatus: true,
      verificationStatus: true,
      failedLoginCount: true,
      lockedUntil: true,
      deletedAt: true,
    },
  });

  // No such user. Burn comparable time, then answer identically.
  if (!user || user.deletedAt) {
    await burnPasswordTime();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  // Locked out. Same message - "this account is locked" is itself a
  // confirmation that the account exists.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await burnPasswordTime();
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  const check = await verifyPassword(password, user.passwordHash);

  if (!check.valid) {
    const nextCount = user.failedLoginCount + 1;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: nextCount,
        lockedUntil:
          nextCount >= MAX_FAILED_ATTEMPTS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      },
    });
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  // Password is correct, but the account may still not be usable. Banned and
  // blocked accounts get the SAME message - telling someone "your account is
  // banned" confirms both that it exists and that their password was right,
  // which is precisely what a credential-stuffer wants to learn.
  if (user.accountStatus === 'BANNED' || user.accountStatus === 'DELETED') {
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }
  if (await isUserBlocked(user.id)) {
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  // --- success -------------------------------------------------------------

  // Opportunistic rehash: bcrypt hashes upgrade to argon2id on the one
  // occasion we legitimately hold the plaintext. No migration, no forced reset.
  const passwordHash = check.needsRehash ? await hashPassword(password) : undefined;

  await db.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      ...(passwordHash ? { passwordHash } : {}),
    },
  });

  const deviceId = deviceFingerprint
    ? await recordDevice({
        userId: user.id,
        fingerprint: deviceFingerprint,
        label: deviceLabel(request.headers.get('user-agent') ?? undefined),
      })
    : undefined;

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

  await db.auditLog.create({
    data: {
      actorId: user.id,
      action: 'USER_LOGIN',
      entityType: 'user',
      entityId: user.id,
      deviceFingerprint,
      userAgent: request.headers.get('user-agent')?.slice(0, 512),
    },
  });

  const response = NextResponse.json({
    user: { id: user.id, verificationStatus: user.verificationStatus },
  });
  session.applyCookies(response);
  return response;
}
