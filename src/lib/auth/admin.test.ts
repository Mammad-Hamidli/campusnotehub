import { describe, expect, it, vi, beforeEach } from 'vitest';
import { UserRole, AccountStatus, VerificationStatus } from '@/lib/enums';

/**
 * Authorization tests for the admin panel.
 *
 * These exercise the real requireAdmin/withAdmin implementation with only
 * requireSession mocked - the point is to prove the TIER LOGIC, so replacing it
 * with a stub would test nothing. Every case here corresponds to a way the
 * panel could leak: a student calling an admin API, a moderator reaching a
 * mutation, an expired session being treated as a forbidden one.
 */

const requireSession = vi.fn();
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, requireSession: (...args: unknown[]) => requireSession(...args) };
});

/**
 * The audit sink is mocked at the REPOSITORY boundary, not at the database
 * client. adminAudit() now writes through writeAuditLog() in the Firestore
 * repository, so mocking `@/lib/db` here would assert against a module the
 * code under test no longer touches - a test that passes while proving
 * nothing.
 */
const writeAuditLog = vi.fn();
vi.mock('@/lib/firebase/repositories/audit', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

const { requireAdmin, withAdmin, adminAudit, ForbiddenError } = await import('@/lib/auth/admin');
const { UnauthorizedError } = await import('@/lib/auth/session');
const { NextRequest } = await import('next/server');

const request = () => new NextRequest('http://localhost:3000/api/admin/users');

function sessionAs(role: UserRole) {
  requireSession.mockResolvedValue({
    userId: `user_${role}`,
    viewer: {
      id: `user_${role}`,
      role,
      accountStatus: AccountStatus.ACTIVE,
      verificationStatus: VerificationStatus.VERIFIED,
    },
  });
}

beforeEach(() => {
  requireSession.mockReset();
  writeAuditLog.mockReset();
});

describe('requireAdmin', () => {
  const nonStaff = [UserRole.STUDENT, UserRole.ALUMNI, UserRole.MENTOR, UserRole.TEACHER];

  it.each(nonStaff)('refuses %s at the MODERATOR tier', async (role) => {
    sessionAs(role);
    await expect(requireAdmin(request(), 'MODERATOR')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(nonStaff)('refuses %s at the ADMIN tier', async (role) => {
    sessionAs(role);
    await expect(requireAdmin(request(), 'ADMIN')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admits a MODERATOR at the MODERATOR tier', async () => {
    sessionAs(UserRole.MODERATOR);
    const actor = await requireAdmin(request(), 'MODERATOR');
    expect(actor.viewer.role).toBe(UserRole.MODERATOR);
  });

  it('refuses a MODERATOR at the ADMIN tier', async () => {
    sessionAs(UserRole.MODERATOR);
    await expect(requireAdmin(request(), 'ADMIN')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admits an ADMIN at both tiers', async () => {
    sessionAs(UserRole.ADMIN);
    await expect(requireAdmin(request(), 'MODERATOR')).resolves.toBeTruthy();
    await expect(requireAdmin(request(), 'ADMIN')).resolves.toBeTruthy();
  });

  it('sets isAdmin only for ADMIN', async () => {
    sessionAs(UserRole.ADMIN);
    expect((await requireAdmin(request(), 'MODERATOR')).isAdmin).toBe(true);
    sessionAs(UserRole.MODERATOR);
    expect((await requireAdmin(request(), 'MODERATOR')).isAdmin).toBe(false);
  });

  it('propagates an unauthenticated session rather than treating it as forbidden', async () => {
    requireSession.mockRejectedValue(new UnauthorizedError());
    await expect(requireAdmin(request(), 'MODERATOR')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('withAdmin', () => {
  it('answers 401 for an unauthenticated caller', async () => {
    requireSession.mockRejectedValue(new UnauthorizedError());
    const response = await withAdmin(request(), 'MODERATOR', async () => 'handler ran');
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
  });

  it('answers 403 for a signed-in non-staff caller', async () => {
    sessionAs(UserRole.STUDENT);
    const response = await withAdmin(request(), 'MODERATOR', async () => 'handler ran');
    expect((response as Response).status).toBe(403);
  });

  it('401 and 403 are distinct so a demoted moderator is not stuck in a login loop', async () => {
    requireSession.mockRejectedValue(new UnauthorizedError());
    const unauth = (await withAdmin(request(), 'ADMIN', async () => null)) as Response;
    sessionAs(UserRole.MODERATOR);
    const forbidden = (await withAdmin(request(), 'ADMIN', async () => null)) as Response;
    expect(unauth.status).toBe(401);
    expect(forbidden.status).toBe(403);
  });

  it('never runs the handler when authorization fails', async () => {
    const handler = vi.fn(async () => 'ran');
    sessionAs(UserRole.STUDENT);
    await withAdmin(request(), 'MODERATOR', handler);
    requireSession.mockRejectedValue(new UnauthorizedError());
    await withAdmin(request(), 'MODERATOR', handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler for an authorized caller', async () => {
    sessionAs(UserRole.ADMIN);
    const result = await withAdmin(request(), 'ADMIN', async (actor) => actor.id);
    expect(result).toBe('user_ADMIN');
  });

  it('converts an unexpected handler error into a 500 without leaking the message', async () => {
    sessionAs(UserRole.ADMIN);
    const response = (await withAdmin(request(), 'ADMIN', async () => {
      throw new Error('column "passwordHash" value abc123');
    })) as Response;
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('errors.generic');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});

describe('adminAudit', () => {
  it('writes a row with the actor, action and entity', async () => {
    await adminAudit({
      actorId: 'admin_1',
      action: 'ADMIN_USER_STATUS_CHANGED',
      entityType: 'user',
      entityId: 'user_9',
      before: { accountStatus: 'ACTIVE' },
      after: { accountStatus: 'SUSPENDED' },
    });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({
      actorId: 'admin_1',
      action: 'ADMIN_USER_STATUS_CHANGED',
      entityType: 'user',
      entityId: 'user_9',
    });
  });

  /**
   * Replaces the old "uses the transaction client when one is supplied" case.
   *
   * That behaviour is genuinely gone rather than merely untested: a Firestore
   * transaction handle cannot be passed across module boundaries, so adminAudit
   * no longer accepts one and the audit row is always written on its own. This
   * asserts the property that survived - the row still records the outcome -
   * so a regression to a silently-dropped audit write is still caught.
   */
  it('defaults result to SUCCESS and records a stated failure', async () => {
    await adminAudit({ actorId: 'admin_1', action: 'ADMIN_USER_DELETED', entityType: 'user' });
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ result: 'SUCCESS' });

    await adminAudit({
      actorId: 'admin_1',
      action: 'ADMIN_USER_DELETED',
      entityType: 'user',
      result: 'DENIED',
    });
    expect(writeAuditLog.mock.calls[1][0]).toMatchObject({ result: 'DENIED' });
    expect(writeAuditLog).toHaveBeenCalledTimes(2);
  });
});
