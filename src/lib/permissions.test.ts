import { describe, expect, it } from 'vitest';
import { AccountStatus, UserRole, VerificationStatus } from '@/lib/enums';
import { can, denialKey, type Viewer } from './permissions';

const viewer = (patch: Partial<Viewer> = {}): Viewer => ({
  id: 'u1',
  role: UserRole.STUDENT,
  accountStatus: AccountStatus.ACTIVE,
  verificationStatus: VerificationStatus.UNVERIFIED,
  ...patch,
});

describe('verification unlocks shopping', () => {
  it.each(['notes:buy', 'wallet:topup', 'notes:sell', 'mentors:book', 'wallet:withdraw'] as const)(
    'refuses %s to an unverified account and grants it once verified',
    (capability) => {
      expect(can(viewer(), capability)).toBe(false);
      expect(can(viewer({ verificationStatus: VerificationStatus.VERIFIED }), capability)).toBe(true);
    },
  );

  it.each(['feed:read', 'feed:post', 'notes:browse', 'mentors:browse'] as const)(
    'keeps %s open to an unverified account',
    (capability) => {
      expect(can(viewer(), capability)).toBe(true);
    },
  );

  it('treats an in-review account as unverified', () => {
    expect(can(viewer({ verificationStatus: VerificationStatus.NEEDS_REVIEW }), 'notes:buy')).toBe(false);
  });
});

describe('denialKey', () => {
  it('names verification when it is the only thing missing', () => {
    expect(denialKey(viewer(), 'notes:buy')).toBe('verification.restricted.action');
  });

  it('stays generic when the account is suspended, verified or not', () => {
    const frozen = viewer({ accountStatus: AccountStatus.SUSPENDED });
    expect(denialKey(frozen, 'notes:buy')).toBe('errors.forbidden');
  });

  it('stays generic for a capability verification does not gate', () => {
    expect(denialKey(viewer(), 'moderation:review')).toBe('errors.forbidden');
  });
});

describe('an unfinished quick-login profile is view-only', () => {
  const incomplete = viewer({ profileIncomplete: true, verificationStatus: VerificationStatus.VERIFIED });

  it.each(['feed:read', 'notes:browse', 'mentors:browse'] as const)('can still %s', (capability) => {
    expect(can(incomplete, capability)).toBe(true);
  });

  it.each(['feed:post', 'feed:comment', 'feed:react', 'users:follow', 'notes:buy', 'mentors:book'] as const)(
    'cannot %s - even when verified',
    (capability) => {
      expect(can(incomplete, capability)).toBe(false);
      expect(can(viewer({ verificationStatus: VerificationStatus.VERIFIED }), capability)).toBe(true);
    },
  );

  it('explains the refusal as "finish your profile", not as verification', () => {
    expect(denialKey(incomplete, 'users:follow')).toBe('onboarding.restricted');
  });
});
