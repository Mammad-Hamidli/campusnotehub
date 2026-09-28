import { VerificationStatus } from '@/lib/enums';
import { VERIFICATION_SETTINGS_HREF } from '@/lib/verification/requirements';

/**
 * The mentor panel's onboarding checklist, derived from live data.
 *
 *   account      always done - the panel is only shown to a mentor account
 *   email        the address is confirmed
 *   identity     /verify (ID only for mentors); in review counts as waiting
 *   application  the mentor profile a moderator reviews (/mentors/apply)
 *   listing      approved AND taking bookings, i.e. bookable in the directory
 *
 * Each step's state is computed, never stored, so the list cannot disagree
 * with the thing it describes. Pure: the page does the reads.
 */

export type ChecklistStepKey = 'account' | 'email' | 'identity' | 'application' | 'listing';

/**
 *   done     finished
 *   current  the mentor has something to do here now
 *   waiting  the mentor is done; someone else (a moderator, the pipeline) is not
 *   locked   an earlier step has to finish first
 */
export type ChecklistStepState = 'done' | 'current' | 'waiting' | 'locked';

export type ChecklistStep = {
  key: ChecklistStepKey;
  state: ChecklistStepState;
  /** The one page that moves this step. */
  href?: string;
  /** A moderator's reason, shown under a rejected application. */
  note?: string | null;
};

export type ChecklistInput = {
  emailVerified: boolean;
  verificationStatus: VerificationStatus;
  application: { status: 'PENDING' | 'APPROVED' | 'REJECTED'; rejectionReason: string | null } | null;
  profile: { isApproved: boolean; isAcceptingBookings: boolean } | null;
};

export function buildMentorChecklist(input: ChecklistInput): ChecklistStep[] {
  const verified = input.verificationStatus === VerificationStatus.VERIFIED;
  const inReview =
    input.verificationStatus === VerificationStatus.PROCESSING ||
    input.verificationStatus === VerificationStatus.NEEDS_REVIEW;
  const approved = input.profile?.isApproved === true || input.application?.status === 'APPROVED';

  const identity: ChecklistStep = {
    key: 'identity',
    state: verified ? 'done' : inReview ? 'waiting' : 'current',
    href: VERIFICATION_SETTINGS_HREF,
  };

  /**
   * Approval outranks everything else about the application: an approved
   * mentor whose identity later lapsed is still approved. Otherwise a pending
   * application is waiting even if identity is not (yet) verified, because
   * it was submitted and a moderator holds it; a new one needs a verified
   * identity, which POST /api/mentors/apply enforces.
   */
  const application: ChecklistStep = approved
    ? { key: 'application', state: 'done' }
    : input.application?.status === 'PENDING'
      ? { key: 'application', state: 'waiting', href: '/mentors/apply' }
      : !verified
        ? { key: 'application', state: 'locked' }
        : {
            key: 'application',
            state: 'current',
            href: '/mentors/apply',
            note: input.application?.status === 'REJECTED' ? input.application.rejectionReason : null,
          };

  const listing: ChecklistStep =
    input.profile?.isApproved && input.profile.isAcceptingBookings
      ? { key: 'listing', state: 'done' }
      : input.profile?.isApproved
        ? { key: 'listing', state: 'current', href: '/mentors/schedule' }
        : { key: 'listing', state: 'locked' };

  return [
    { key: 'account', state: 'done' },
    {
      key: 'email',
      state: input.emailVerified ? 'done' : 'current',
      // The resend button lives in Settings -> Security (EmailPanel).
      href: '/settings/security',
    },
    identity,
    application,
    listing,
  ];
}
