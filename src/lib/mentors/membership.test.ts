import { describe, expect, it } from 'vitest';
import { UserRole } from '@/lib/enums';
import { mentorActivationPending, mentorJoinDate, mentorSincePatchForRoleChange, roleAfterMentorApproval } from './membership';

const now = new Date('2026-09-28T10:00:00Z');
const earlier = new Date('2026-01-10T10:00:00Z');

describe('roleAfterMentorApproval', () => {
  it('promotes a student to MENTOR', () => {
    expect(roleAfterMentorApproval(UserRole.STUDENT)).toBe(UserRole.MENTOR);
  });

  it.each([UserRole.ALUMNI, UserRole.TEACHER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.MENTOR])(
    'leaves %s as it is',
    (role) => {
      expect(roleAfterMentorApproval(role)).toBe(role);
    },
  );
});

describe('mentorSincePatchForRoleChange', () => {
  it('stamps the join date when MENTOR is first granted', () => {
    expect(mentorSincePatchForRoleChange({ role: UserRole.STUDENT }, UserRole.MENTOR, now)).toEqual({
      mentorSince: now,
    });
  });

  it('keeps the original join date when MENTOR is granted again', () => {
    expect(
      mentorSincePatchForRoleChange({ role: UserRole.ALUMNI, mentorSince: earlier }, UserRole.MENTOR, now),
    ).toEqual({});
  });

  it('clears the join date when MENTOR is taken away', () => {
    expect(
      mentorSincePatchForRoleChange({ role: UserRole.MENTOR, mentorSince: earlier }, UserRole.STUDENT, now),
    ).toEqual({ mentorSince: null });
  });

  it('touches nothing for a change between other roles', () => {
    expect(
      mentorSincePatchForRoleChange({ role: UserRole.ALUMNI, mentorSince: earlier }, UserRole.TEACHER, now),
    ).toEqual({});
  });
});

describe('mentorJoinDate', () => {
  it('prefers mentorSince', () => {
    expect(mentorJoinDate({ role: UserRole.MENTOR, mentorSince: earlier, createdAt: now })).toBe(earlier);
  });

  it('falls back to the signup date for a MENTOR written before the field existed', () => {
    expect(mentorJoinDate({ role: UserRole.MENTOR, createdAt: earlier })).toBe(earlier);
  });

  it('is null for an account that is not a mentor', () => {
    expect(mentorJoinDate({ role: UserRole.STUDENT, mentorSince: null, createdAt: earlier })).toBeNull();
  });
});

describe('mentorActivationPending', () => {
  it('holds a PENDING or REJECTED registration and releases APPROVED and legacy accounts', () => {
    expect(mentorActivationPending({ mentorRegistrationStatus: 'PENDING' })).toBe(true);
    expect(mentorActivationPending({ mentorRegistrationStatus: 'REJECTED' })).toBe(true);
    expect(mentorActivationPending({ mentorRegistrationStatus: 'APPROVED' })).toBe(false);
    expect(mentorActivationPending({ mentorRegistrationStatus: null })).toBe(false);
    expect(mentorActivationPending({})).toBe(false);
  });

  it('gives an unpaid MENTOR account no join date to bill from', () => {
    expect(
      mentorJoinDate({ role: UserRole.MENTOR, mentorSince: null, createdAt: earlier, mentorRegistrationStatus: 'PENDING' }),
    ).toBeNull();
  });
});
