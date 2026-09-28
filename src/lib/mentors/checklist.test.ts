import { describe, expect, it } from 'vitest';
import { VerificationStatus } from '@/lib/enums';
import { buildMentorChecklist, type ChecklistInput } from './checklist';

const fresh: ChecklistInput = {
  emailVerified: false,
  verificationStatus: VerificationStatus.UNVERIFIED,
  application: null,
  profile: null,
};

const states = (input: Partial<ChecklistInput>) =>
  Object.fromEntries(buildMentorChecklist({ ...fresh, ...input }).map((s) => [s.key, s.state]));

describe('buildMentorChecklist', () => {
  it('starts a new mentor on email and identity, with the application locked', () => {
    expect(states({})).toEqual({
      account: 'done',
      email: 'current',
      identity: 'current',
      application: 'locked',
      listing: 'locked',
    });
  });

  it('shows identity in review as waiting', () => {
    expect(states({ verificationStatus: VerificationStatus.NEEDS_REVIEW }).identity).toBe('waiting');
    expect(states({ verificationStatus: VerificationStatus.PROCESSING }).identity).toBe('waiting');
  });

  it('opens the application once identity is verified', () => {
    const steps = buildMentorChecklist({ ...fresh, verificationStatus: VerificationStatus.VERIFIED });
    expect(steps.find((s) => s.key === 'application')).toMatchObject({ state: 'current', href: '/mentors/apply' });
  });

  it('waits on a pending application', () => {
    expect(
      states({
        verificationStatus: VerificationStatus.VERIFIED,
        application: { status: 'PENDING', rejectionReason: null },
      }).application,
    ).toBe('waiting');
  });

  it('carries the moderator reason on a rejected application', () => {
    const steps = buildMentorChecklist({
      ...fresh,
      verificationStatus: VerificationStatus.VERIFIED,
      application: { status: 'REJECTED', rejectionReason: 'Add your work history' },
    });
    expect(steps.find((s) => s.key === 'application')).toMatchObject({
      state: 'current',
      note: 'Add your work history',
    });
  });

  it('asks an approved mentor who is not taking bookings to open the schedule', () => {
    const steps = buildMentorChecklist({
      ...fresh,
      emailVerified: true,
      verificationStatus: VerificationStatus.VERIFIED,
      application: { status: 'APPROVED', rejectionReason: null },
      profile: { isApproved: true, isAcceptingBookings: false },
    });
    expect(steps.find((s) => s.key === 'listing')).toMatchObject({ state: 'current', href: '/mentors/schedule' });
  });

  it('is all done for a listed mentor', () => {
    const all = states({
      emailVerified: true,
      verificationStatus: VerificationStatus.VERIFIED,
      application: { status: 'APPROVED', rejectionReason: null },
      profile: { isApproved: true, isAcceptingBookings: true },
    });
    expect(Object.values(all).every((s) => s === 'done')).toBe(true);
  });
});
