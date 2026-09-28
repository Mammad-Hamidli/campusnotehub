import { describe, expect, it } from 'vitest';
import { UserRole } from '@/lib/enums';
import { mentorJoinDate, mentorSincePatchForRoleChange, roleAfterMentorApproval } from './membership';

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
