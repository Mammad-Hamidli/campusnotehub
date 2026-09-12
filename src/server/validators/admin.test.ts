import { describe, expect, it } from 'vitest';
import { AccountStatus, UserRole } from '@/lib/enums';
import {
  adminUserListSchema,
  adminStatusChangeSchema,
  adminFreezeSchema,
  adminRoleChangeSchema,
  adminDeleteUserSchema,
  adminUniversityCreateSchema,
} from './admin';
import { maskPhone } from '@/lib/admin/redact';

/**
 * These guard the two things in the query layer that are security controls
 * rather than conveniences: the sort allow-list and the page-size ceiling.
 */
describe('adminUserListSchema', () => {
  it('rejects a sort field that is not on the allow-list', () => {
    // The whole reason `sort` is an enum: this string is interpolated into a
    // Prisma orderBy, and ordering by a hash column leaks it one bit at a time.
    for (const field of ['passwordHash', 'emailHash', 'phoneHash', 'id; DROP TABLE users']) {
      expect(adminUserListSchema.safeParse({ sort: field }).success).toBe(false);
    }
  });

  it('accepts every advertised sort field', () => {
    for (const field of ['createdAt', 'updatedAt', 'lastLoginAt', 'fullName', 'nickname', 'email']) {
      expect(adminUserListSchema.safeParse({ sort: field }).success).toBe(true);
    }
  });

  it('caps page size so the endpoint cannot become a full-table export', () => {
    expect(adminUserListSchema.safeParse({ pageSize: '100' }).success).toBe(true);
    expect(adminUserListSchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(adminUserListSchema.safeParse({ pageSize: '1000000' }).success).toBe(false);
  });

  it('rejects a non-positive page', () => {
    expect(adminUserListSchema.safeParse({ page: '0' }).success).toBe(false);
    expect(adminUserListSchema.safeParse({ page: '-3' }).success).toBe(false);
  });

  it('defaults to newest first and hides soft-deleted accounts', () => {
    const parsed = adminUserListSchema.parse({});
    expect(parsed.sort).toBe('createdAt');
    expect(parsed.order).toBe('desc');
    expect(parsed.includeDeleted).toBe(false);
  });

  it('treats an empty filter value as absent rather than as a filter', () => {
    const parsed = adminUserListSchema.parse({ q: '', universityId: '' });
    expect(parsed.q).toBeUndefined();
    expect(parsed.universityId).toBeUndefined();
  });

  it('rejects an unknown enum value', () => {
    expect(adminUserListSchema.safeParse({ role: 'SUPERADMIN' }).success).toBe(false);
    expect(adminUserListSchema.safeParse({ accountStatus: 'NOPE' }).success).toBe(false);
  });
});

describe('adminStatusChangeSchema', () => {
  it('does not allow BANNED or DELETED to be set directly', () => {
    // Banning must go through applyBan so the blocklist rows are written with
    // it; deletion has its own endpoint and its own confirmation.
    expect(adminStatusChangeSchema.safeParse({ accountStatus: AccountStatus.BANNED, reason: 'a'.repeat(20) }).success).toBe(false);
    expect(adminStatusChangeSchema.safeParse({ accountStatus: AccountStatus.DELETED, reason: 'a'.repeat(20) }).success).toBe(false);
  });

  it('allows the reversible statuses', () => {
    for (const status of [AccountStatus.ACTIVE, AccountStatus.RESTRICTED, AccountStatus.SUSPENDED]) {
      expect(adminStatusChangeSchema.safeParse({ accountStatus: status, reason: 'a'.repeat(20) }).success).toBe(true);
    }
  });

  it('requires a reason of at least 10 characters', () => {
    expect(adminStatusChangeSchema.safeParse({ accountStatus: 'ACTIVE', reason: 'short' }).success).toBe(false);
    expect(adminStatusChangeSchema.safeParse({ accountStatus: 'ACTIVE' }).success).toBe(false);
  });
});

describe('adminRoleChangeSchema', () => {
  /**
   * This suite previously asserted the OPPOSITE for three of these roles:
   * ALUMNI, MENTOR and TEACHER were rejected on the reasoning that they are
   * owned by the graduation cron and the mentor application flow, so setting
   * one by hand would produce a state those systems did not create.
   *
   * That reasoning still holds for the AUTOMATED transitions, and they are
   * unchanged - the cron and the application flow still own their own paths.
   * What it did not account for is the admin acting as the system of last
   * resort: a graduate the annual sweep missed, a lecturer who must be TEACHER
   * on day one, a mentor approved out of band. Refusing those did not prevent
   * the change, it just pushed the operator into editing the database
   * directly - with no audit row, no reason, no confirmation and no session
   * revocation. That is strictly worse than allowing it here.
   *
   * The safeguards that actually matter were never in this schema anyway. They
   * are in the handler, which still refuses self-demotion, still refuses to
   * remove the last ADMIN, and now revokes sessions when a grant crosses the
   * staff boundary.
   */
  it('allows every assignable role', () => {
    for (const role of [
      UserRole.STUDENT,
      UserRole.ALUMNI,
      UserRole.MENTOR,
      UserRole.TEACHER,
      UserRole.MODERATOR,
      UserRole.ADMIN,
    ]) {
      expect(adminRoleChangeSchema.safeParse({ role, reason: 'a'.repeat(20) }).success).toBe(true);
    }
  });

  it('still rejects a value that is not a role at all', () => {
    expect(adminRoleChangeSchema.safeParse({ role: 'SUPERADMIN', reason: 'a'.repeat(20) }).success).toBe(false);
  });

  it('still requires a reason', () => {
    expect(adminRoleChangeSchema.safeParse({ role: UserRole.ADMIN, reason: 'short' }).success).toBe(false);
  });
});

describe('adminFreezeSchema', () => {
  it('accepts a reason with no expiry, which means an indefinite freeze', () => {
    expect(adminFreezeSchema.safeParse({ reason: 'a'.repeat(20) }).success).toBe(true);
  });

  it('accepts an expiry in the future', () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect(adminFreezeSchema.safeParse({ reason: 'a'.repeat(20), until }).success).toBe(true);
  });

  it('rejects an expiry in the past', () => {
    // A freeze that has already elapsed is not a freeze; it would be lifted on
    // the account's very next request.
    const until = new Date(Date.now() - 60_000).toISOString();
    expect(adminFreezeSchema.safeParse({ reason: 'a'.repeat(20), until }).success).toBe(false);
  });

  it('rejects a freeze longer than a year', () => {
    // A "temporary" freeze measured in decades is a ban wearing a disguise,
    // and bans have their own path because they carry blocklist rows with them.
    const until = new Date(Date.now() + 400 * 86_400_000).toISOString();
    expect(adminFreezeSchema.safeParse({ reason: 'a'.repeat(20), until }).success).toBe(false);
  });

  it('still requires a reason of at least 10 characters', () => {
    expect(adminFreezeSchema.safeParse({ reason: 'short' }).success).toBe(false);
  });
});

describe('adminDeleteUserSchema', () => {
  it('requires both a reason and the typed nickname', () => {
    expect(adminDeleteUserSchema.safeParse({ reason: 'a'.repeat(20) }).success).toBe(false);
    expect(adminDeleteUserSchema.safeParse({ confirmNickname: 'someone' }).success).toBe(false);
    expect(adminDeleteUserSchema.safeParse({ reason: 'a'.repeat(20), confirmNickname: 'someone' }).success).toBe(true);
  });
});

describe('adminUniversityCreateSchema', () => {
  it('rejects a malformed email domain', () => {
    const base = { code: 'TEST', nameAz: 'a', nameEn: 'a', nameRu: 'a', city: 'Baku' };
    expect(adminUniversityCreateSchema.safeParse({ ...base, nameAz: 'aa', nameEn: 'aa', nameRu: 'aa', emailDomains: ['not a domain'] }).success).toBe(false);
    expect(adminUniversityCreateSchema.safeParse({ ...base, nameAz: 'aa', nameEn: 'aa', nameRu: 'aa', emailDomains: ['ada.edu.az'] }).success).toBe(true);
  });

  it('rejects a lowercase code', () => {
    expect(adminUniversityCreateSchema.safeParse({ code: 'ada', nameAz: 'aa', nameEn: 'aa', nameRu: 'aa', city: 'Baku' }).success).toBe(false);
  });
});

describe('maskPhone', () => {
  it('keeps the operator prefix and last two digits only', () => {
    const masked = maskPhone('+994501234567');
    expect(masked).toMatch(/^\+99450\*+67$/);
    expect(masked).not.toContain('1234');
  });

  it('never returns the full number', () => {
    const phone = '+994551112233';
    expect(maskPhone(phone)).not.toBe(phone);
  });

  it('handles absent and very short values', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone('12345')).toBe('*****');
  });
});
