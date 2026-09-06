import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import { AccountStatus, UserRole, type VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import type { Viewer } from '@/lib/permissions';

/**
 * Access-token lifetime.
 *
 * ---------------------------------------------------------------------------
 * WHY STAFF GET A LONGER ONE, AND WHY THAT IS NOT A WEAKENING
 * ---------------------------------------------------------------------------
 * 15 minutes is right for a student: the app is a feed they dip into, and
 * there is no refresh endpoint, so an expired token means a bounce to /login.
 * For an administrator working a verification queue that is unusable - they
 * were being logged out mid-review, repeatedly, which is how "the admin
 * session is too short" became a bug report.
 *
 * The naive fix is to raise the TTL for everyone, and the naive objection to
 * raising it for admins is "a longer token means a longer window after a ban".
 * BOTH of those are answered by the change made in requireSession() below:
 * the token now carries the session row's id (`sid`) and every request checks
 * that row is still live. Revoking a session - by logging out, by an admin
 * revoking it, by a status change - invalidates the access token IMMEDIATELY,
 * regardless of how much of its TTL is left.
 *
 * So the TTL no longer bounds "how long a revoked operator keeps access"; it
 * only bounds how long a token stays cryptographically fresh between database
 * checks, and there is a database check on every single request. Three hours
 * for staff is therefore a convenience decision with no security cost, and it
 * is the smaller of the two changes in this file.
 */
const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900);
const ADMIN_ACCESS_TTL = Math.max(
  Number(process.env.ADMIN_ACCESS_TOKEN_TTL_SECONDS ?? 3 * 60 * 60),
  // Never shorter than the ordinary TTL: a misconfigured env var must not
  // silently give staff a WORSE session than a student.
  ACCESS_TTL,
);
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

const STAFF_ROLES: ReadonlySet<UserRole> = new Set([UserRole.ADMIN, UserRole.MODERATOR]);

/** Chooses the TTL from the role. Exported for the tests and for /api/me. */
export function accessTtlFor(role: UserRole): number {
  return STAFF_ROLES.has(role) ? ADMIN_ACCESS_TTL : ACCESS_TTL;
}

/**
 * Split-token session.
 *
 * Access token: short-lived, signed EdDSA JWT. Carries `sub` (user), `sid`
 * (session row) and `ver` (verification status) - never a role or a permission
 * list, because those are checked server-side against live data anyway and
 * stale claims are a footgun.
 *
 * Refresh token: opaque random string. Only its HMAC is stored, so a database
 * leak yields no usable sessions. Rotated on every use with reuse detection:
 * presenting an already-rotated refresh token means the token was stolen, and
 * the correct response is to revoke the entire family, not just that token.
 */
const COOKIE_ACCESS = 'CH_AT';
const COOKIE_REFRESH = 'CH_RT';

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const, // 'lax' not 'strict': OAuth-style returns and email links must work
  path: '/',
};

let privateKey: Promise<CryptoKey> | null = null;
let publicKey: Promise<CryptoKey> | null = null;
const getPrivateKey = () => (privateKey ??= importPKCS8(process.env.JWT_PRIVATE_KEY_PEM!, 'EdDSA'));
const getPublicKey = () => (publicKey ??= importSPKI(process.env.JWT_PUBLIC_KEY_PEM!, 'EdDSA'));

export type SessionUser = {
  id: string;
  role: UserRole;
  verificationStatus: VerificationStatus;
  accountStatus: AccountStatus;
};

export async function issueSession(params: {
  user: SessionUser;
  userAgent: string;
  /** FK to UserDevice. Sessions are tied to a device, never to an address. */
  deviceId?: string;
}) {
  const refreshToken = newOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);

  /**
   * The session row is created BEFORE the access token is signed, because the
   * token now has to carry the row's id. The previous order (sign, then
   * insert) is what made it impossible to tie a token back to a session.
   */
  const session = await db.session.create({
    data: {
      userId: params.user.id,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: params.userAgent.slice(0, 512),
      deviceId: params.deviceId,
      expiresAt,
    },
    select: { id: true },
  });

  const ttl = accessTtlFor(params.user.role);

  const accessToken = await new SignJWT({ ver: params.user.verificationStatus, sid: session.id })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(params.user.id)
    .setIssuer('campushub')
    .setAudience('campushub-web')
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(await getPrivateKey());

  return {
    accessToken,
    refreshToken,
    sessionId: session.id,
    applyCookies(response: NextResponse) {
      response.cookies.set(COOKIE_ACCESS, accessToken, { ...cookieOptions, maxAge: ttl });
      response.cookies.set(COOKIE_REFRESH, refreshToken, {
        ...cookieOptions,
        maxAge: REFRESH_TTL_DAYS * 86_400,
        path: '/api/auth', // the refresh token is never sent to page requests
      });
      return response;
    },
  };
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  readonly messageKey = 'errors.sessionExpired';
}

/** Clears both cookies. Used by logout and by every "your session is gone" path. */
export function clearSessionCookies(response: NextResponse): NextResponse {
  response.cookies.set(COOKIE_ACCESS, '', { ...cookieOptions, maxAge: 0 });
  response.cookies.set(COOKIE_REFRESH, '', { ...cookieOptions, path: '/api/auth', maxAge: 0 });
  return response;
}

/**
 * For route handlers. Verifies the JWT, then loads live session AND account
 * state.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SESSION ROW IS CHECKED HERE - THE BACK-BUTTON BUG
 * ---------------------------------------------------------------------------
 * This function used to verify the JWT and then load only the USER. That left
 * a real hole, and it is the one behind "log out, press back, and the admin
 * panel is still there":
 *
 *   /logout revoked the session row and deleted the cookies, but the access
 *   token itself remained cryptographically valid for the rest of its TTL.
 *   Nothing on the server ever consulted the row that logout had revoked, so
 *   any restored copy of that cookie - from a browser cache, a synced profile,
 *   an extension, a copied curl command - was accepted as a live session.
 *   Revocation, session revocation from the admin panel included, was
 *   therefore advisory rather than enforced.
 *
 * Adding `sid` to the token and checking it here makes revocation immediate
 * and universal: logout, admin session revocation, refresh-token reuse
 * detection and account status changes all work by writing `revokedAt`, and
 * this is the single place that now honours it.
 *
 * The cost is one indexed lookup per request, and it is fetched in the SAME
 * query as the user via a relation include, so it is not an extra round trip.
 */
export async function requireSession(request?: NextRequest): Promise<{
  userId: string;
  sessionId: string;
  viewer: Viewer;
}> {
  const jar = request ? request.cookies : await cookies();
  const token = jar.get(COOKIE_ACCESS)?.value;
  if (!token) throw new UnauthorizedError();

  let sub: string;
  let sid: string | null;
  try {
    const { payload } = await jwtVerify(token, await getPublicKey(), {
      issuer: 'campushub',
      audience: 'campushub-web',
    });
    sub = payload.sub!;
    sid = typeof payload.sid === 'string' ? payload.sid : null;
  } catch {
    throw new UnauthorizedError();
  }

  /**
   * A token with no `sid` predates this change. It is REFUSED rather than
   * grandfathered: accepting it would leave exactly the bypass described above
   * open to anyone holding a token minted before the deploy, and the cost of
   * refusing is that sessions issued before the deploy have to sign in again -
   * a one-time inconvenience, bounded by the old 15-minute TTL.
   */
  if (!sid) throw new UnauthorizedError();

  const session = await db.session.findUnique({
    where: { id: sid },
    select: {
      id: true,
      userId: true,
      revokedAt: true,
      expiresAt: true,
      user: {
        select: {
          id: true,
          role: true,
          accountStatus: true,
          verificationStatus: true,
          deletedAt: true,
          frozenUntil: true,
        },
      },
    },
  });

  const now = new Date();

  if (
    !session ||
    session.revokedAt ||
    session.expiresAt < now ||
    // The token's subject and the session's owner must agree. They always do
    // when we minted both, so a mismatch means a forged or spliced token.
    session.userId !== sub
  ) {
    throw new UnauthorizedError();
  }

  const user = session.user;
  if (!user || user.deletedAt || user.accountStatus === AccountStatus.BANNED || user.accountStatus === AccountStatus.DELETED) {
    throw new UnauthorizedError();
  }

  /**
   * A temporary freeze that has run out is lifted here, on the account's own
   * next request, so an admin who forgets to unfreeze cannot strand someone.
   * Fire-and-forget: the viewer below is corrected in memory either way, so
   * the request proceeds with the right permissions even if the write is slow.
   */
  const effectiveStatus =
    user.accountStatus === AccountStatus.SUSPENDED && user.frozenUntil && user.frozenUntil <= now
      ? AccountStatus.ACTIVE
      : user.accountStatus;

  if (effectiveStatus !== user.accountStatus) {
    void db.user
      .update({
        where: { id: user.id },
        data: { accountStatus: AccountStatus.ACTIVE, frozenUntil: null, frozenReason: null, frozenAt: null, frozenById: null },
      })
      .catch(() => {});
  }

  // Cheap liveness signal for the admin "active sessions" list. Not awaited:
  // it must never add latency to an authenticated request.
  void db.session.update({ where: { id: session.id }, data: { lastSeenAt: now } }).catch(() => {});

  return {
    userId: user.id,
    sessionId: session.id,
    viewer: {
      id: user.id,
      role: user.role,
      accountStatus: effectiveStatus,
      verificationStatus: user.verificationStatus,
      frozenUntil: user.frozenUntil,
    },
  };
}

/** Non-throwing variant for pages that render differently when signed out. */
export async function getViewer(): Promise<Viewer | null> {
  try {
    const { viewer } = await requireSession();
    return viewer;
  } catch {
    return null;
  }
}

/**
 * Refresh with rotation and reuse detection. A refresh token is valid exactly
 * once; presenting a revoked one is treated as theft.
 */
export async function rotateSession(refreshToken: string, userAgent: string) {
  const tokenHash = hashToken(refreshToken);
  const existing = await db.session.findUnique({
    where: { refreshTokenHash: tokenHash },
    include: { user: { select: { id: true, role: true, accountStatus: true, verificationStatus: true, deletedAt: true } } },
  });

  if (!existing) throw new UnauthorizedError();

  if (existing.revokedAt) {
    // Reuse of a rotated token: revoke every session this user holds.
    await db.session.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await db.auditLog.create({
      data: {
        actorId: existing.userId,
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        entityType: 'session',
        entityId: existing.id,
        result: 'DENIED',
      },
    });
    throw new UnauthorizedError();
  }

  if (
    existing.expiresAt < new Date() ||
    existing.user.deletedAt ||
    existing.user.accountStatus === AccountStatus.BANNED ||
    existing.user.accountStatus === AccountStatus.DELETED
  ) {
    throw new UnauthorizedError();
  }

  await db.session.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  return issueSession({ user: existing.user, userAgent, deviceId: existing.deviceId ?? undefined });
}

export async function revokeSession(refreshToken: string) {
  await db.session.updateMany({
    where: { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revokes by session id. Used by /logout, which holds the access token (and
 * therefore the sid) but NOT the refresh token on a page request - CH_RT is
 * scoped to /api/auth by design.
 *
 * Without this, signing out from a page could only delete cookies and leave
 * the row live, which is half of the back-button bug described above.
 */
export async function revokeSessionById(sessionId: string) {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
