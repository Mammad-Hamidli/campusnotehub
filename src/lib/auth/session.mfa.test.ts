import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus, UserRole, VerificationStatus } from '@/lib/enums';

/**
 * The staff MFA gate, end to end through the real session code.
 *
 * issueSession() signs a real EdDSA token, requireSession() verifies it and
 * reads the session row, and requireAdmin() sits on top - only storage is
 * replaced. What is asserted is the security property itself: a staff account
 * whose SESSION has not proven a second factor carries no staff role, and
 * refreshing a session can neither add nor drop a factor.
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
};
const sessions = new Map<string, Row>();
const refreshIndex = new Map<string, string>();
let nextId = 0;

vi.mock('@/lib/firebase/admin.core', () => ({
  adminDb: () => ({ collection: () => ({ doc: () => ({ id: `s${++nextId}` }), add: async () => {} }) }),
}));

vi.mock('@/lib/firebase/repositories/sessions', () => ({
  createSession: async (p: Omit<Row, 'createdAt' | 'lastSeenAt' | 'revokedAt' | 'userAgent'> & { userAgent: string; refreshTokenHash: string }) => {
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

const users = new Map<string, { id: string; role: UserRole }>();
vi.mock('@/lib/firebase/repositories/users', () => ({
  findUserById: async (id: string) => {
    const u = users.get(id);
    return u
      ? {
          ...u,
          accountStatus: AccountStatus.ACTIVE,
          verificationStatus: VerificationStatus.VERIFIED,
          deletedAt: null,
          frozenUntil: null,
        }
      : null;
  },
  updateUser: async () => {},
}));

vi.mock('@/lib/firebase/repositories/audit', () => ({ writeAuditLog: async () => {} }));

const { issueSession, requireSession, rotateSession } = await import('./session');
const { requireAdmin, MfaRequiredError } = await import('./admin');
const { NextRequest } = await import('next/server');

async function signIn(role: UserRole, amr: string[]) {
  const id = `user_${role}_${amr.join('_')}`;
  users.set(id, { id, role });
  const issued = await issueSession({
    user: { id, role, accountStatus: AccountStatus.ACTIVE, verificationStatus: VerificationStatus.VERIFIED },
    userAgent: 'test',
    amr,
    mfaAt: amr.includes('otp') || amr.includes('recovery') ? new Date() : null,
  });
  const request = new NextRequest('http://localhost:3000/api/admin/users', {
    headers: { cookie: `CH_AT=${issued.accessToken}` },
  });
  return { issued, request };
}

beforeEach(() => {
  sessions.clear();
  refreshIndex.clear();
  users.clear();
});

describe('staff MFA gate in requireSession', () => {
  it.each([UserRole.ADMIN, UserRole.MODERATOR])('withholds the %s role from a password-only session', async (role) => {
    const { request } = await signIn(role, ['pwd']);
    const session = await requireSession(request);

    expect(session.viewer.role).toBe(UserRole.STUDENT);
    expect(session.viewer.mfaRequired).toBe(true);
    // The real role is still known to the MFA endpoints, and nothing else.
    expect(session.accountRole).toBe(role);
    await expect(requireAdmin(request, 'MODERATOR')).rejects.toBeInstanceOf(MfaRequiredError);
  });

  it.each([
    [UserRole.ADMIN, ['pwd', 'otp']],
    [UserRole.MODERATOR, ['pwd', 'recovery']],
  ])('grants %s once the session has proven %j', async (role, amr) => {
    const { request } = await signIn(role, amr);
    const session = await requireSession(request);

    expect(session.viewer.role).toBe(role);
    expect(session.viewer.mfaRequired).toBe(false);
    await expect(requireAdmin(request, 'MODERATOR')).resolves.toMatchObject({ id: session.userId });
  });

  it('treats a legacy session row with no amr as having no second factor', async () => {
    const { issued, request } = await signIn(UserRole.ADMIN, ['pwd', 'otp']);
    sessions.get(issued.sessionId)!.amr = [];
    expect((await requireSession(request)).viewer.role).toBe(UserRole.STUDENT);
  });

  it('applies an upgrade on the next request, without a new token', async () => {
    const { issued, request } = await signIn(UserRole.ADMIN, ['pwd']);
    expect((await requireSession(request)).viewer.role).toBe(UserRole.STUDENT);

    sessions.get(issued.sessionId)!.amr = ['pwd', 'otp'];
    expect((await requireSession(request)).viewer.role).toBe(UserRole.ADMIN);
  });

  it.each([UserRole.STUDENT, UserRole.MENTOR, UserRole.TEACHER, UserRole.ALUMNI])(
    'leaves %s untouched on a password-only session',
    async (role) => {
      const { request } = await signIn(role, ['pwd']);
      const session = await requireSession(request);
      expect(session.viewer.role).toBe(role);
      expect(session.viewer.mfaRequired).toBe(false);
    },
  );
});

describe('rotateSession', () => {
  it('carries the proven factors and their time over unchanged', async () => {
    const { issued } = await signIn(UserRole.ADMIN, ['pwd', 'otp']);
    const original = sessions.get(issued.sessionId)!;

    const rotated = await rotateSession(issued.refreshToken, 'test');
    const next = sessions.get(rotated.sessionId)!;
    expect(next.amr).toEqual(['pwd', 'otp']);
    expect(next.mfaAt).toEqual(original.mfaAt);
  });

  it('cannot turn a password-only session into a verified one', async () => {
    const { issued } = await signIn(UserRole.ADMIN, ['pwd']);
    const rotated = await rotateSession(issued.refreshToken, 'test');
    expect(sessions.get(rotated.sessionId)!.amr).toEqual(['pwd']);
  });
});
