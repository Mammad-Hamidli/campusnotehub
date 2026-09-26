import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus, UserRole, VerificationStatus } from '@/lib/enums';

/**
 * The desktop-app session policy, through the real session code and the real
 * /api/auth/desktop route - only storage is replaced (same harness as
 * session.mfa.test.ts).
 *
 * What is asserted: a web session is exactly what it was (session cookies,
 * 30-minute idle ceiling); a desktop session has persistent cookies and a
 * 7-day sliding lifetime; rotation never moves a session between the two; and
 * only the app's own navigation can mark a browser as the desktop app.
 */

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.JWT_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.JWT_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

type Row = {
  id: string;
  userId: string;
  userAgent: string;
  deviceId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  amr: string[];
  mfaAt: Date | null;
  authAt: Date;
  client: 'web' | 'desktop';
};
const sessions = new Map<string, Row>();
const refreshIndex = new Map<string, string>();
let nextId = 0;

vi.mock('@/lib/firebase/admin.core', () => ({
  adminDb: () => ({ collection: () => ({ doc: () => ({ id: `s${++nextId}` }), add: async () => {} }) }),
}));

vi.mock('@/lib/firebase/repositories/sessions', () => ({
  createSession: async (p: Omit<Row, 'createdAt' | 'lastSeenAt' | 'revokedAt'> & { refreshTokenHash: string }) => {
    const now = new Date();
    const row: Row = {
      id: p.id,
      userId: p.userId,
      userAgent: p.userAgent,
      deviceId: p.deviceId ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: p.expiresAt,
      revokedAt: null,
      amr: p.amr,
      mfaAt: p.mfaAt,
      authAt: p.authAt,
      client: p.client,
    };
    sessions.set(p.id, row);
    refreshIndex.set(p.refreshTokenHash, p.id);
    return row;
  },
  findSessionById: async (id: string) => sessions.get(id) ?? null,
  findSessionByRefreshHash: async (hash: string) => sessions.get(refreshIndex.get(hash) ?? '') ?? null,
  revokeSessionById: async (id: string) => {
    const row = sessions.get(id);
    if (row) row.revokedAt = new Date();
  },
  revokeUserSessions: async () => 0,
  touchSession: async () => {},
}));

vi.mock('@/lib/firebase/repositories/users', () => ({
  findUserById: async (id: string) => ({
    id,
    role: UserRole.STUDENT,
    accountStatus: AccountStatus.ACTIVE,
    verificationStatus: VerificationStatus.VERIFIED,
    deletedAt: null,
    frozenUntil: null,
  }),
  updateUser: async () => {},
}));

const { issueSession, requireSession, rotateSession, sessionClientOf, sessionIsLive, UnauthorizedError } =
  await import('./session');
const { GET: launch } = await import('@/app/api/auth/desktop/route');
const { NextRequest, NextResponse } = await import('next/server');

const DAY = 86_400_000;

async function signIn(client: 'web' | 'desktop') {
  const issued = await issueSession({
    user: {
      id: 'u1',
      role: UserRole.STUDENT,
      accountStatus: AccountStatus.ACTIVE,
      verificationStatus: VerificationStatus.VERIFIED,
    },
    userAgent: 'test',
    amr: ['pwd'],
    mfaAt: null,
    client,
  });
  const row = sessions.get(issued.sessionId)!;
  const request = new NextRequest('http://localhost:3000/api/me', {
    headers: { cookie: `CH_AT=${issued.accessToken}` },
  });
  return { issued, row, request };
}

function cookieLine(response: InstanceType<typeof NextResponse>, name: string): string | undefined {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

beforeEach(() => {
  sessions.clear();
  refreshIndex.clear();
});

describe('web sessions (unchanged)', () => {
  it('writes session cookies with no Max-Age and a 30-day row', async () => {
    const { issued, row } = await signIn('web');
    const response = issued.applyCookies(NextResponse.next());

    expect(cookieLine(response, 'CH_AT')).not.toMatch(/Max-Age|Expires/i);
    expect(cookieLine(response, 'CH_RT')).not.toMatch(/Max-Age|Expires/i);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
  });

  it('is revoked after the 30-minute idle ceiling', async () => {
    const { row, request } = await signIn('web');
    row.lastSeenAt = new Date(Date.now() - 31 * 60_000);

    await expect(requireSession(request)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(row.revokedAt).not.toBeNull();
  });
});

describe('desktop sessions', () => {
  it('writes persistent cookies and a 7-day row', async () => {
    const { issued, row } = await signIn('desktop');
    const response = issued.applyCookies(NextResponse.next());

    expect(cookieLine(response, 'CH_AT')).toContain('Max-Age=900');
    expect(cookieLine(response, 'CH_RT')).toContain(`Max-Age=${7 * 86_400}`);
    expect(cookieLine(response, 'CH_RT')).toContain('Path=/api/auth');
    const lifetime = row.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(7 * DAY - 60_000);
    expect(lifetime).toBeLessThanOrEqual(7 * DAY);
  });

  it('survives days of inactivity, but not more than seven', async () => {
    const { row, request } = await signIn('desktop');

    row.lastSeenAt = new Date(Date.now() - 3 * DAY);
    await expect(requireSession(request)).resolves.toMatchObject({ userId: 'u1' });
    expect(sessionIsLive(row)).toBe(true);

    row.lastSeenAt = new Date(Date.now() - 8 * DAY);
    expect(sessionIsLive(row)).toBe(false);
    await expect(requireSession(request)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('stays a desktop session across rotation, and a web session stays web', async () => {
    const desktop = await signIn('desktop');
    const rotated = await rotateSession(desktop.issued.refreshToken, 'test');
    expect(sessions.get(rotated.sessionId)!.client).toBe('desktop');
    expect(cookieLine(rotated.applyCookies(NextResponse.next()), 'CH_RT')).toContain('Max-Age=');

    const web = await signIn('web');
    const rotatedWeb = await rotateSession(web.issued.refreshToken, 'test');
    expect(sessions.get(rotatedWeb.sessionId)!.client).toBe('web');
    expect(cookieLine(rotatedWeb.applyCookies(NextResponse.next()), 'CH_RT')).not.toMatch(/Max-Age/i);
  });
});

describe('sessionClientOf', () => {
  it('is desktop only for the exact marker value', () => {
    const jar = (value?: string) => ({ get: () => (value === undefined ? undefined : { value }) });
    expect(sessionClientOf(jar('desktop'))).toBe('desktop');
    expect(sessionClientOf(jar('web'))).toBe('web');
    expect(sessionClientOf(jar('DESKTOP'))).toBe('web');
    expect(sessionClientOf(jar())).toBe('web');
  });
});

describe('GET /api/auth/desktop', () => {
  const call = (headers: Record<string, string>) =>
    launch(new NextRequest('http://localhost:3000/api/auth/desktop', { headers }));

  it('sends a signed-out app to /login and marks it as the desktop app', async () => {
    const response = await call({ 'sec-fetch-site': 'none' });

    expect(response.headers.get('location')).toBe('http://localhost:3000/login');
    expect(cookieLine(response, 'CH_CLIENT')).toContain('CH_CLIENT=desktop');
    expect(cookieLine(response, 'CH_CLIENT')).toMatch(/HttpOnly/i);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts the same-origin hop from the landing page', async () => {
    expect(cookieLine(await call({ 'sec-fetch-site': 'same-origin' }), 'CH_CLIENT')).toBeDefined();
  });

  it('does not let another site mark a browser as the desktop app', async () => {
    expect(cookieLine(await call({ 'sec-fetch-site': 'cross-site' }), 'CH_CLIENT')).toBeUndefined();
    expect(cookieLine(await call({ 'sec-fetch-site': 'same-site' }), 'CH_CLIENT')).toBeUndefined();
    expect(cookieLine(await call({}), 'CH_CLIENT')).toBeUndefined();
  });

  it('renews an expired access token from the refresh token after a restart', async () => {
    const { issued } = await signIn('desktop');
    const response = await call({ 'sec-fetch-site': 'none', cookie: `CH_RT=${issued.refreshToken}` });

    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(cookieLine(response, 'CH_AT')).toBeDefined();
    expect(cookieLine(response, 'CH_RT')).toContain('Max-Age=');
    expect(cookieLine(response, 'CH_RF')).toBeDefined();
    expect(sessions.get(issued.sessionId)!.revokedAt).not.toBeNull();
  });

  it('forwards a live session without rotating it', async () => {
    const { issued, row } = await signIn('desktop');
    const response = await call({ 'sec-fetch-site': 'none', cookie: `CH_AT=${issued.accessToken}` });

    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(row.revokedAt).toBeNull();
  });

  it('sends a signed-out-by-logout app (revoked row) to /login', async () => {
    const { issued, row } = await signIn('desktop');
    row.revokedAt = new Date(Date.now() - 5 * 60_000);
    const response = await call({
      'sec-fetch-site': 'same-origin',
      cookie: `CH_AT=${issued.accessToken}`,
    });

    expect(response.headers.get('location')).toBe('http://localhost:3000/login');
  });
});
