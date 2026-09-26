import { cache } from 'react';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { SignJWT, jwtVerify, compactVerify, importPKCS8, importSPKI } from 'jose';
import { AccountStatus, UserRole, type VerificationStatus } from '@/lib/enums';
import { hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { forFirestore } from '@/lib/firebase/convert';
import {
  createSession,
  findSessionByRefreshHash,
  findSessionById,
  revokeSessionById as revokeSessionRecord,
  revokeUserSessions,
  touchSession,
  type SessionClient,
} from '@/lib/firebase/repositories/sessions';
import { findUserById, updateUser } from '@/lib/firebase/repositories/users';
import type { Viewer } from '@/lib/permissions';

/**
 * Access-token lifetime.
 *
 * ---------------------------------------------------------------------------
 * WHY STAFF GET A LONGER ONE, AND WHY THAT IS NOT A WEAKENING
 * ---------------------------------------------------------------------------
 * 15 minutes is right for a student: the app is a feed they dip into, and an
 * expired token is renewed transparently from the 30-day refresh token by
 * /api/auth/refresh (see SessionKeeper and the middleware).
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
/** See rotateSession(): concurrent refreshes inside this window are not treated as theft. */
const REFRESH_REUSE_GRACE_MS = 60_000;

/**
 * Idle ceiling on a session row, in minutes. 0 disables it.
 *
 * ---------------------------------------------------------------------------
 * WHY AN IDLE TIMEOUT EXISTS ALONGSIDE SESSION COOKIES
 * ---------------------------------------------------------------------------
 * The cookies below are session cookies, so closing the browser normally
 * discards them and the next visit starts signed out. That is the mechanism,
 * and on its own it is the whole answer - EXCEPT that "close the browser" is
 * not a promise the browser keeps. Chrome's "continue where you left off",
 * Firefox's session restore and mobile tab restoration all hand session
 * cookies back after a restart, and a page can do nothing about it.
 *
 * So the guarantee is made server-side instead, where it cannot be overridden:
 * a session row that has not been used for this long is DEAD, and it is
 * actively revoked on the first request that finds it stale - which also kills
 * the refresh token, so a restored cookie cannot mint a new session either.
 *
 * `lastSeenAt` is written by touchSession() on every authenticated request
 * (API calls and, since the page guards were added, protected navigations
 * too), so this only ever fires after real inactivity.
 */
const IDLE_TIMEOUT_MINUTES = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES ?? 30);
const IDLE_TIMEOUT_MS = Math.max(0, IDLE_TIMEOUT_MINUTES) * 60_000;

/**
 * Lifetime of a session signed in from the Windows app, in days. Default 7.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DESKTOP APP IS THE ONE EXCEPTION TO EVERYTHING ABOVE
 * ---------------------------------------------------------------------------
 * "Closing the browser signs you out" is right for a browser: it may be a
 * library machine, and the next person opens the same profile. The desktop app
 * (desktop/) is installed per Windows user into that user's own profile, and
 * people expect it to behave like every other installed app - still signed in
 * tomorrow. Applied to it, the web rules signed people out every time they
 * closed the window and after half an hour of reading.
 *
 * So a session whose row says client === 'desktop' gets, instead:
 *   - cookies WITH Max-Age, so they survive the app closing (see applyCookies);
 *   - this many days as both its lifetime and its idle ceiling. Every refresh
 *     re-issues the row with a fresh expiresAt, so the window slides: someone
 *     who opens the app at least once a week is never signed out by a timer.
 *
 * What does NOT change: logout, admin revocation, bans and refresh-token reuse
 * detection all revoke the row and take effect on the next request; the access
 * token keeps its 15-minute TTL; re-authentication for sensitive actions still
 * reads authAt. The client is decided at sign-in (sessionClientOf) and copied
 * on rotation, so a web session can never turn into a desktop one mid-flight.
 *
 * `||`, not `??`: an empty DESKTOP_SESSION_TTL_DAYS= line in .env reads as ""
 * and would otherwise become a zero-day session.
 */
const DESKTOP_SESSION_DAYS = Number(process.env.DESKTOP_SESSION_TTL_DAYS) || 7;
const DESKTOP_SESSION_MS = DESKTOP_SESSION_DAYS * 86_400_000;

function lifetimeMs(client: SessionClient): number {
  return client === 'desktop' ? DESKTOP_SESSION_MS : REFRESH_TTL_DAYS * 86_400_000;
}

/** True when a session row has sat unused past its client's idle ceiling. */
function isIdle(row: { lastSeenAt: Date; client?: SessionClient }, now: Date): boolean {
  const ceiling = row.client === 'desktop' ? DESKTOP_SESSION_MS : IDLE_TIMEOUT_MS;
  return ceiling > 0 && now.getTime() - row.lastSeenAt.getTime() > ceiling;
}

/**
 * Would requireSession() still accept this row? Not revoked, not expired, not
 * idle. The Devices list uses it so a row that is only waiting for its next
 * request to be revoked is not shown as a signed-in device.
 */
export function sessionIsLive(
  row: { revokedAt: Date | null; expiresAt: Date; lastSeenAt: Date; client?: SessionClient },
  now = new Date(),
): boolean {
  return !row.revokedAt && row.expiresAt > now && !isIdle(row, now);
}

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
export const COOKIE_ACCESS = 'CH_AT';
export const COOKIE_REFRESH = 'CH_RT';
/** Short-lived loop-breaker written by /api/auth/refresh. Auth state, so it dies with the rest. */
export const COOKIE_REFRESHED = 'CH_RF';
/** The refresh token is never sent to page requests. */
export const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * Marks a WebView2 profile as the desktop app's. Written only by GET
 * /api/auth/desktop (the app's start page) and read at sign-in by
 * sessionClientOf(). It is not auth state, so signing out leaves it: the app's
 * next screen is still its own sign-in page, not the marketing site.
 */
export const COOKIE_CLIENT = 'CH_CLIENT';

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const, // 'lax' not 'strict': OAuth-style returns and email links must work
  path: '/',
};

type CookieReader = { get(name: string): { value: string } | undefined };

/** The client a NEW sign-in on this request belongs to. Rotation copies the row's instead. */
export function sessionClientOf(jar: CookieReader): SessionClient {
  return jar.get(COOKIE_CLIENT)?.value === 'desktop' ? 'desktop' : 'web';
}

/** 400 days is the longest Max-Age Chromium keeps; the app re-sets it on every launch. */
export function markDesktopClient(response: NextResponse): NextResponse {
  response.cookies.set(COOKIE_CLIENT, 'desktop', { ...cookieOptions, maxAge: 400 * 86_400 });
  return response;
}

/**
 * Short-lived marker the middleware and the landing page read to avoid a
 * redirect loop if a freshly issued token somehow still fails verification.
 * Written after a successful refresh (/api/auth/refresh, /api/auth/desktop).
 */
export function markRefreshed(response: NextResponse): NextResponse {
  response.cookies.set(COOKIE_REFRESHED, '1', { ...cookieOptions, maxAge: 15 });
  return response;
}

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
  /**
   * Factors proven to get here (see SessionRecord.amr). Required, not
   * defaulted: a caller that forgot to say how the user authenticated must
   * not silently mint a session that claims less - or more - than happened.
   */
  amr: string[];
  /** When a second factor was proven; carried over unchanged on refresh. */
  mfaAt: Date | null;
  /** Original sign-in time. Omitted for a new sign-in; passed on rotation. */
  authAt?: Date;
  /**
   * Required for the same reason as amr: it decides how long the session
   * lives and whether it survives a restart. sessionClientOf(request) for a
   * new sign-in, the existing row's value on rotation.
   */
  client: SessionClient;
}) {
  const refreshToken = newOpaqueToken();
  const lifetime = lifetimeMs(params.client);
  const expiresAt = new Date(Date.now() + lifetime);

  /**
   * The session row is created BEFORE the access token is signed, because the
   * token now has to carry the row's id. The previous order (sign, then
   * insert) is what made it impossible to tie a token back to a session.
   */
  /**
   * The document id is generated up front so the JWT can carry it.
   *
   * Firestore hands out an id without a round trip - `.doc()` with no argument
   * creates the reference locally - which keeps the original ordering intact:
   * the session id must exist before the token that names it is signed.
   */
  const sessionId = adminDb().collection(COLLECTIONS.sessions).doc().id;

  const session = await createSession({
    id: sessionId,
    userId: params.user.id,
    refreshTokenHash: hashToken(refreshToken),
    userAgent: params.userAgent,
    deviceId: params.deviceId ?? null,
    expiresAt,
    amr: params.amr,
    mfaAt: params.mfaAt,
    authAt: params.authAt ?? new Date(),
    client: params.client,
  });

  const ttl = accessTtlFor(params.user.role);

  const accessToken = await new SignJWT({ ver: params.user.verificationStatus, sid: session.id })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(params.user.id)
    .setIssuer('campusnotehub')
    .setAudience('campusnotehub-web')
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(await getPrivateKey());

  return {
    accessToken,
    refreshToken,
    sessionId: session.id,
    /**
     * Writes both cookies as SESSION cookies - no Max-Age, no Expires.
     *
     * -----------------------------------------------------------------------
     * WHY NEITHER COOKIE IS ALLOWED TO PERSIST
     * -----------------------------------------------------------------------
     * These used to carry `maxAge`: 15 minutes (or three hours for staff) on
     * CH_AT and THIRTY DAYS on CH_RT. That is what wrote them to disk, and a
     * cookie on disk is a cookie that outlives the browser. Quitting the
     * browser and reopening it replayed CH_RT to /api/auth/refresh, which
     * happily minted a fresh session - the user had never signed out, so
     * nothing server-side objected. "It logs me back in by itself after a
     * restart" was that Max-Age, and no amount of client-side cleanup could
     * have reached it.
     *
     * Without those attributes the browser holds both cookies in memory only
     * and drops them when it closes, which is precisely the required
     * behaviour: a restart starts signed out.
     *
     * The LIFETIMES THEMSELVES ARE UNCHANGED and are still enforced, just from
     * the side that cannot be tampered with: the JWT carries its own `exp`
     * (ttl, below) and the session row carries `expiresAt` (REFRESH_TTL_DAYS)
     * plus the idle ceiling above. Dropping the cookie attribute removes the
     * browser's copy of the deadline, not the deadline.
     *
     * The one exception is a desktop-app session (see DESKTOP_SESSION_DAYS):
     * there, surviving a restart IS the requirement, so both cookies carry a
     * Max-Age equal to their server-side deadline. CH_AT still dies with its
     * 15-minute token; CH_RT lasts as long as the row and is re-set, with a
     * fresh Max-Age, on every rotation.
     */
    applyCookies(response: NextResponse) {
      const persist = params.client === 'desktop';
      response.cookies.set(COOKIE_ACCESS, accessToken, {
        ...cookieOptions,
        ...(persist ? { maxAge: ttl } : {}),
      });
      response.cookies.set(COOKIE_REFRESH, refreshToken, {
        ...cookieOptions,
        path: REFRESH_COOKIE_PATH,
        ...(persist ? { maxAge: Math.floor(lifetime / 1000) } : {}),
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
 * Clears every cookie this module can have written. Used by logout and by
 * every "your session is gone" path.
 *
 * ---------------------------------------------------------------------------
 * WHY CH_RT IS EXPIRED AT TWO PATHS, AND WHY CH_RF IS HERE AT ALL
 * ---------------------------------------------------------------------------
 * A cookie is identified by (name, domain, path), so an expiry only deletes
 * the cookie whose path it names. CH_RT lives at /api/auth, and clearing it at
 * `/` - which is what `cookies.delete('CH_RT')` does, and what middleware.ts
 * was doing on the ban path - deletes nothing and leaves a live refresh token
 * in the browser. Both paths are expired here so the wipe holds whichever path
 * a given browser stored it under, including one written by an older deploy.
 *
 * CH_RF is not a credential, but it is auth state: the middleware reads it to
 * decide whether it has already tried a refresh, so a copy that outlives the
 * session changes routing for a signed-out visitor. It dies with the rest.
 */
export function clearSessionCookies(response: NextResponse): NextResponse {
  const expire = { ...cookieOptions, maxAge: 0, expires: new Date(0) };
  response.cookies.set(COOKIE_ACCESS, '', expire);
  response.cookies.set(COOKIE_REFRESH, '', { ...expire, path: REFRESH_COOKIE_PATH });
  response.cookies.set(COOKIE_REFRESHED, '', expire);

  /**
   * The second CH_RT expiry is appended as a RAW HEADER, not set again.
   *
   * ResponseCookies.set() keys by NAME alone, so calling it twice for CH_RT -
   * once for /api/auth and once for / - does not emit two Set-Cookie headers.
   * The second call REPLACES the first, and the only one sent is the one for
   * `/`, which matches no stored cookie. The result is worse than not trying:
   * the refresh token at /api/auth survives a sign-out that reports success.
   * Appending the header directly is the only way to expire the same name at
   * two paths in one response.
   *
   * The canonical path is the one above; this covers a CH_RT written at `/` by
   * an older deploy, which would otherwise be permanently unreachable.
   */
  const secure = cookieOptions.secure ? '; Secure' : '';
  response.headers.append(
    'set-cookie',
    `${COOKIE_REFRESH}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
  );
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
export type SessionResult = {
  userId: string;
  sessionId: string;
  viewer: Viewer;
  /** Factors proven on this session. See SessionRecord.amr. */
  amr: string[];
  mfaAt: Date | null;
  /** When the person signed in (survives refresh rotation; see SessionRecord.authAt). */
  authenticatedAt: Date;
  /** The account's REAL role, even when `viewer.role` is withheld (below). */
  accountRole: UserRole;
};

const STAFF_REQUIRING_MFA: ReadonlySet<UserRole> = new Set([UserRole.ADMIN, UserRole.MODERATOR]);

/** True when this session proved a second factor. */
export function sessionHasMfa(amr: readonly string[]): boolean {
  return amr.includes('otp') || amr.includes('recovery');
}

/**
 * ---------------------------------------------------------------------------
 * WHY THE COOKIE PATH IS MEMOISED PER REQUEST
 * ---------------------------------------------------------------------------
 * A server-rendered page resolves the session at least twice now: once in the
 * root layout, which mounts the identity prompt, and once in the page itself
 * through requirePageSession(). Both run in the same React render pass for the
 * same request, and each one costs two Firestore document reads - so without
 * this, adding one global component would have doubled the read volume of
 * every signed-in page view. Firestore is billed per read and each one is a
 * network round trip, so that is latency AND money for an answer we already
 * had.
 *
 * React's cache() memoises for the lifetime of a single request and nothing
 * longer. Two callers in one render share one lookup; the next request starts
 * clean, which is what keeps revocation immediate - the property the whole
 * function exists to provide.
 *
 * It is applied ONLY to the no-argument (cookie) path. When a NextRequest is
 * passed - route handlers, middleware - the arguments are not comparable by
 * identity across calls and there is no render pass to scope the cache to, so
 * that path calls straight through, exactly as before.
 */
const cachedCookieSession = cache(
  async (): Promise<SessionResult> => loadSession(undefined),
);

/**
 * `passive`: a background request (the live notification poll) that must not
 * count as activity. It is authenticated like any other, but does NOT move
 * `lastSeenAt` - otherwise an unattended open tab would never reach the idle
 * timeout. SessionKeeper likewise never refreshes tokens for such a request.
 */
export async function requireSession(
  request?: NextRequest,
  options: { passive?: boolean } = {},
): Promise<SessionResult> {
  return request ? loadSession(request, options.passive === true) : cachedCookieSession();
}

async function loadSession(request?: NextRequest, passive = false): Promise<SessionResult> {
  const jar = request ? request.cookies : await cookies();
  const token = jar.get(COOKIE_ACCESS)?.value;
  if (!token) throw new UnauthorizedError();

  let sub: string;
  let sid: string | null;
  try {
    const { payload } = await jwtVerify(token, await getPublicKey(), {
      issuer: 'campusnotehub',
      audience: 'campusnotehub-web',
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

  /**
   * Two reads, not a join.
   *
   * Prisma fetched the session and its user in one query with a relation
   * include. Firestore has no joins, so this is a document read for the
   * session followed by one for the user - both by primary key, both O(1),
   * and the second is skipped entirely when the session is already invalid.
   */
  const session = await findSessionById(sid);
  const now = new Date();

  if (!session || session.revokedAt || session.expiresAt < now || session.userId !== sub) {
    throw new UnauthorizedError();
  }

  /**
   * Idle sessions are revoked, not merely refused.
   *
   * Refusing would leave the row live and its refresh token usable, so the
   * very next call to /api/auth/refresh would hand back a brand new session -
   * which is the restored-cookie case this is here to stop. Writing revokedAt
   * kills both halves of the pair at once.
   */
  if (isIdle(session, now)) {
    await revokeSessionRecord(session.id);
    throw new UnauthorizedError();
  }

  const user = await findUserById(session.userId);

  // The token's subject and the session's owner must agree - checked above.
  // They always do when we minted both, so a mismatch means a forged token.
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
    void updateUser(user.id, {
      accountStatus: AccountStatus.ACTIVE,
      frozenUntil: null,
      frozenReason: null,
      frozenAt: null,
      frozenById: null,
    }).catch(() => {});
  }

  // Cheap liveness signal for the admin "active sessions" list. Not awaited:
  // it must never add latency to an authenticated request.
  if (!passive) void touchSession(session.id, now).catch(() => {});

  /**
   * ---------------------------------------------------------------------------
   * STAFF POWERS REQUIRE A SECOND FACTOR - ENFORCED HERE, ONCE
   * ---------------------------------------------------------------------------
   * An ADMIN or MODERATOR whose session has not proven a second factor gets a
   * viewer carrying an ordinary member's role, plus `mfaRequired`.
   *
   * Why here and not in requireAdmin(): staff privileges are not confined to
   * /api/admin. permissions.can('moderation:review'), deleting another
   * person's post, and reading any note's file all branch on `viewer.role`
   * directly. Gating only the admin API would leave those open to a stolen
   * password. Withholding the role at the one place every viewer is built
   * makes every existing check - and every future one - fail closed without
   * having to remember MFA.
   *
   * STUDENT is the least-privileged member role. The account keeps its real
   * role in the database; `accountRole` exposes it to the few callers that
   * must know it (the MFA endpoints: staff may not switch 2FA off).
   *
   * The same applies to sessions minted before this change: they carry no
   * `amr`, so a staff member must verify once to get the panel back.
   */
  const mfaRequired = STAFF_REQUIRING_MFA.has(user.role) && !sessionHasMfa(session.amr);

  return {
    userId: user.id,
    sessionId: session.id,
    amr: session.amr,
    mfaAt: session.mfaAt,
    authenticatedAt: session.authAt,
    accountRole: user.role,
    viewer: {
      id: user.id,
      role: mfaRequired ? UserRole.STUDENT : user.role,
      accountStatus: effectiveStatus,
      verificationStatus: user.verificationStatus,
      frozenUntil: user.frozenUntil,
      mfaRequired,
      profileIncomplete: user.profileIncomplete === true,
      passwordSetupRequired: user.passwordSetupRequired === true,
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
  const existing = await findSessionByRefreshHash(tokenHash);

  if (!existing) throw new UnauthorizedError();

  /**
   * Grace window for concurrent refreshes.
   *
   * Two tabs (or two parallel 401s) can present the same refresh token a few
   * hundred milliseconds apart. The first rotates it; without this window the
   * second would look like theft and revoke EVERY session the user holds. A
   * replay inside the window still gets no new session - it just does not
   * trigger the family-wide revocation.
   */
  if (existing.revokedAt && Date.now() - existing.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
    throw new UnauthorizedError();
  }

  if (existing.revokedAt) {
    /**
     * Reuse of a rotated token: revoke every session this user holds.
     *
     * The audit row is written directly rather than through adminAudit(),
     * which takes a NextRequest this function does not have. Same collection,
     * same shape - see src/lib/auth/admin.ts.
     */
    await revokeUserSessions(existing.userId);
    await adminDb()
      .collection(COLLECTIONS.auditLogs)
      .add(
        forFirestore({
          actorId: existing.userId,
          action: 'REFRESH_TOKEN_REUSE_DETECTED',
          entityType: 'session',
          entityId: existing.id,
          result: 'DENIED',
          createdAt: new Date(),
        }),
      );
    throw new UnauthorizedError();
  }

  /**
   * Same idle ceiling as requireSession(), applied before the token is allowed
   * to rotate. This is the check a browser that restored its session cookies
   * after a restart actually meets: the access token is long expired, so the
   * only thing it can present is CH_RT, and it arrives here.
   */
  if (isIdle(existing, new Date())) {
    await revokeSessionRecord(existing.id);
    throw new UnauthorizedError();
  }

  const user = await findUserById(existing.userId);

  if (
    existing.expiresAt < new Date() ||
    !user ||
    user.deletedAt ||
    user.accountStatus === AccountStatus.BANNED ||
    user.accountStatus === AccountStatus.DELETED
  ) {
    throw new UnauthorizedError();
  }

  await revokeSessionRecord(existing.id);
  return issueSession({
    user: {
      id: user.id,
      role: user.role,
      accountStatus: user.accountStatus,
      verificationStatus: user.verificationStatus,
    },
    userAgent,
    deviceId: existing.deviceId ?? undefined,
    // Rotation continues the SAME sign-in: it proves possession of the refresh
    // token and nothing else, so it inherits the factors and their timestamp
    // exactly - it can never add one, and must never drop one.
    amr: existing.amr,
    mfaAt: existing.mfaAt,
    authAt: existing.authAt,
    // Same sign-in, same client: its lifetime rules come from where it began.
    client: existing.client,
  });
}

export async function revokeSession(refreshToken: string) {
  const existing = await findSessionByRefreshHash(hashToken(refreshToken));
  if (existing) await revokeSessionRecord(existing.id);
}

/**
 * Reads the session id out of an access token WITHOUT enforcing its expiry.
 *
 * ---------------------------------------------------------------------------
 * WHY LOGOUT NEEDS A CHECK THAT IGNORES `exp`
 * ---------------------------------------------------------------------------
 * /logout identified the session to revoke by calling requireSession(), which
 * refuses an expired token. So signing out more than fifteen minutes after the
 * last activity - the ordinary case for anyone who leaves a tab open - threw,
 * and the handler fell through to "just clear the cookies". The session row
 * stayed live, and with it the refresh token, which is NOT sent to this path
 * and therefore could not be revoked by the other branch either. Sign-out was
 * a local cookie wipe and nothing more, on the exact schedule that makes it
 * most likely to matter.
 *
 * The signature is still verified in full - compactVerify proves we minted the
 * token, so a forged `sid` cannot be used to revoke someone else's session.
 * Only the expiry claim is ignored, which is sound here because the ONLY thing
 * this identity is used for is destroying the session it names. The worst a
 * replayed expired token can do through this path is log its own holder out.
 */
export async function sessionIdFromAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await compactVerify(token, await getPublicKey());
    const claims = JSON.parse(new TextDecoder().decode(payload)) as {
      sid?: unknown;
      iss?: unknown;
      aud?: unknown;
    };
    if (claims.iss !== 'campusnotehub' || claims.aud !== 'campusnotehub-web') return null;
    return typeof claims.sid === 'string' ? claims.sid : null;
  } catch {
    return null;
  }
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
  await revokeSessionRecord(sessionId);
}
