import { AccountStatus, UserRole, VerificationStatus } from '@prisma/client';

export type Capability =
  | 'feed:read'
  | 'feed:post'
  | 'feed:comment'
  | 'notes:browse'
  | 'notes:buy'
  | 'notes:sell'
  | 'mentors:browse'
  | 'mentors:book'
  | 'mentors:offer'
  | 'wallet:topup'
  | 'wallet:withdraw'
  | 'moderation:review';

export type Viewer = {
  id: string;
  role: UserRole;
  accountStatus: AccountStatus;
  verificationStatus: VerificationStatus;
};

/**
 * The gate behind the "Account Unverified" banner, in one table.
 *
 * The shape of this list is the product decision: unverified users get the
 * full *social* product and can *spend* money, but cannot *earn* money, cannot
 * *withdraw* money, and cannot get in front of a mentor. Anything that moves
 * value out of the platform or puts a stranger in a 1-on-1 call with a student
 * requires a verified identity; everything else stays open so the platform is
 * useful on day one and people actually finish the funnel.
 */
const REQUIRES_VERIFICATION: ReadonlySet<Capability> = new Set([
  'notes:sell',
  'mentors:book',
  'mentors:offer',
  'wallet:withdraw',
]);

/** Capabilities that survive even a suspended account (read-only escape hatch). */
const ALWAYS_ALLOWED: ReadonlySet<Capability> = new Set(['feed:read', 'notes:browse', 'mentors:browse']);

export function can(viewer: Viewer | null, capability: Capability): boolean {
  if (!viewer) return ALWAYS_ALLOWED.has(capability) && capability !== 'feed:read';

  if (viewer.accountStatus === AccountStatus.BANNED || viewer.accountStatus === AccountStatus.DELETED) {
    return false;
  }
  if (viewer.accountStatus === AccountStatus.SUSPENDED) {
    return ALWAYS_ALLOWED.has(capability);
  }

  if (capability === 'moderation:review') {
    return viewer.role === UserRole.MODERATOR || viewer.role === UserRole.ADMIN;
  }
  if (capability === 'mentors:offer') {
    return (
      viewer.verificationStatus === VerificationStatus.VERIFIED &&
      (viewer.role === UserRole.MENTOR || viewer.role === UserRole.ALUMNI || viewer.role === UserRole.TEACHER)
    );
  }
  if (capability === 'wallet:withdraw' && viewer.accountStatus === AccountStatus.RESTRICTED) {
    return false;
  }

  if (REQUIRES_VERIFICATION.has(capability)) {
    return viewer.verificationStatus === VerificationStatus.VERIFIED;
  }
  return true;
}

export class ForbiddenError extends Error {
  constructor(
    public readonly capability: Capability,
    public readonly messageKey = 'verification.restricted.title',
  ) {
    super(`Missing capability: ${capability}`);
  }
}

export function assertCan(viewer: Viewer | null, capability: Capability): asserts viewer is Viewer {
  if (!can(viewer, capability)) throw new ForbiddenError(capability);
}

/** Drives the banner component without leaking the whole permission table. */
export function verificationBannerState(viewer: Viewer | null) {
  if (!viewer) return null;
  switch (viewer.verificationStatus) {
    case VerificationStatus.UNVERIFIED:
      return { tone: 'warning', key: 'verification.banner.unverified', ctaKey: 'verification.banner.unverifiedCta', href: '/verify' } as const;
    case VerificationStatus.PROCESSING:
      return { tone: 'info', key: 'verification.banner.pending', ctaKey: null, href: null } as const;
    case VerificationStatus.NEEDS_REVIEW:
      return { tone: 'info', key: 'verification.banner.needsReview', ctaKey: null, href: null } as const;
    case VerificationStatus.REJECTED:
      return { tone: 'danger', key: 'verification.banner.rejected', ctaKey: 'verification.banner.rejectedCta', href: '/verify' } as const;
    default:
      return null;
  }
}
