import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import type { AccountStatus, UserRole, VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import type { Viewer } from '@/lib/permissions';

const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900);
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

/**
 * Split-token session.
 *
 * Access token: short-lived, signed EdDSA JWT, readable by the edge middleware
 * with no database round trip. Carries only `sub` and `ver` (verification
 * status) - never a role or a permission list, because those are checked
 * server-side against live data anyway and stale claims are a footgun.
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
  const accessToken = await new SignJWT({ ver: params.user.verificationStatus })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(params.user.id)
    .setIssuer('campushub')
    .setAudience('campushub-web')
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .sign(await getPrivateKey());

  const refreshToken = newOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);

  await db.session.create({
    data: {
      userId: params.user.id,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: params.userAgent.slice(0, 512),
      deviceId: params.deviceId,
      expiresAt,
    },
  });

  return {
    accessToken,
    refreshToken,
    applyCookies(response: NextResponse) {
      response.cookies.set(COOKIE_ACCESS, accessToken, { ...cookieOptions, maxAge: ACCESS_TTL });
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

/**
 * For route handlers. Verifies the JWT, then loads live account state -
 * because a user banned two minutes ago still holds a valid, unexpired access
 * token, and "wait 15 minutes for the token to expire" is not an acceptable
 * answer for a fraud ban.
 */
export async function requireSession(request?: NextRequest): Promise<{
  userId: string;
  viewer: Viewer;
}> {
  const jar = request ? request.cookies : await cookies();
  const token = jar.get(COOKIE_ACCESS)?.value;
  if (!token) throw new UnauthorizedError();

  let sub: string;
  try {
    const { payload } = await jwtVerify(token, await getPublicKey(), {
      issuer: 'campushub',
      audience: 'campushub-web',
    });
    sub = payload.sub!;
  } catch {
    throw new UnauthorizedError();
  }

  const user = await db.user.findUnique({
    where: { id: sub },
    select: { id: true, role: true, accountStatus: true, verificationStatus: true, deletedAt: true },
  });

  if (!user || user.deletedAt || user.accountStatus === 'BANNED' || user.accountStatus === 'DELETED') {
    throw new UnauthorizedError();
  }

  return { userId: user.id, viewer: user };
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
    include: { user: { select: { id: true, role: true, accountStatus: true, verificationStatus: true } } },
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
      },
    });
    throw new UnauthorizedError();
  }

  if (existing.expiresAt < new Date() || existing.user.accountStatus === 'BANNED') {
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
