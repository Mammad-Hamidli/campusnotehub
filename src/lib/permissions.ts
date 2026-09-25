import { AccountStatus, UserRole, VerificationStatus } from '@/lib/enums';
import { VERIFICATION_SETTINGS_HREF } from '@/lib/verification/requirements';

export type Capability =
  | 'feed:read'
  | 'feed:post'
  | 'feed:comment'
  | 'feed:react'
  | 'users:follow'
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
  /**
   * Set while a temporary freeze is in force. Carried on the viewer so the UI
   * can say WHEN access returns instead of only that it is gone - "frozen
   * until Friday" is a support ticket avoided.
   *
   * Optional because several callers build a Viewer from a narrower select.
   * It is never the authorisation input; accountStatus is. See can().
   */
  frozenUntil?: Date | null;
  /**
   * A staff account on a session that has not proven a second factor. Its
   * `role` above is already withheld (see requireSession); this flag only lets
   * the UI send the person to /settings/security instead of a bare 403.
   */
  mfaRequired?: boolean;
  /**
   * An account created through a quick login (Google)
   * that has not yet filled in name, nickname and university. It still holds
   * its temporary handle ("user34232"), so it is VIEW-ONLY until the profile
   * is completed at /onboarding - see can() below.
   */
  profileIncomplete?: boolean;
  /**
   * A Google-only account that owes its first local password. View-only, like
   * an incomplete profile, until it is set at /set-password.
   */
  passwordSetupRequired?: boolean;
};

/**
 * The gate behind the "Verify your identity" banner, in one table.
 *
 * The product decision: an unverified account gets the full SOCIAL product
 * (read, post, comment, browse notes and mentors), and verification unlocks
 * everything that moves money or puts two strangers in a room - buying and
 * selling notes, topping up and withdrawing, booking or offering mentorship.
 *
 * Spending used to be open on day one. It moved behind verification so that
 * every transaction on the platform has a verified person on both sides.
 * `wallet:topup` moved with `notes:buy`: an account that can load money but
 * cannot spend or withdraw it would just have money stuck in the wallet.
 */
const REQUIRES_VERIFICATION: ReadonlySet<Capability> = new Set([
  'notes:buy',
  'notes:sell',
  'mentors:book',
  'mentors:offer',
  'wallet:topup',
  'wallet:withdraw',
]);

/**
 * Capabilities that survive even a suspended (frozen) account.
 *
 * A freeze is a pause, not a ban, so it deliberately leaves a read-only
 * escape hatch: the account can still sign in and read, which is what lets
 * someone actually read the notice explaining why they were frozen and appeal
 * it. Everything that writes, earns, spends, or reaches another person is off.
 */
const ALWAYS_ALLOWED: ReadonlySet<Capability> = new Set(['feed:read', 'notes:browse', 'mentors:browse']);

export function can(viewer: Viewer | null, capability: Capability): boolean {
  if (!viewer) return ALWAYS_ALLOWED.has(capability) && capability !== 'feed:read';

  if (viewer.accountStatus === AccountStatus.BANNED || viewer.accountStatus === AccountStatus.DELETED) {
    return false;
  }
  if (viewer.accountStatus === AccountStatus.SUSPENDED) {
    return ALWAYS_ALLOWED.has(capability);
  }

  /**
   * View-only until the profile is complete. A temporary "user34232" posting,
   * commenting, liking or following would put an anonymous, unattributable
   * handle in front of everyone else - so the same read-only set a freeze
   * leaves open is all an incomplete profile gets.
   */
  if (viewer.profileIncomplete || viewer.passwordSetupRequired) {
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

/**
 * The message key for a refusal, so the client can say WHY and point at the
 * fix. When the only thing between the viewer and the capability is
 * verification, that is what the user is told (and the UI links to the
 * settings section); every other refusal stays the generic forbidden, which
 * leaks nothing about bans or freezes to a caller who should not learn it.
 */
export function denialKey(viewer: Viewer | null, capability: Capability): string {
  if (viewer?.profileIncomplete && !ALWAYS_ALLOWED.has(capability)) {
    return 'onboarding.restricted';
  }
  if (viewer?.passwordSetupRequired && !ALWAYS_ALLOWED.has(capability)) {
    return 'auth.setPassword.restricted';
  }
  if (
    viewer &&
    REQUIRES_VERIFICATION.has(capability) &&
    viewer.verificationStatus !== VerificationStatus.VERIFIED &&
    can({ ...viewer, verificationStatus: VerificationStatus.VERIFIED }, capability)
  ) {
    return 'verification.restricted.action';
  }
  return 'errors.forbidden';
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
      return { tone: 'warning', key: 'verification.banner.unverified', ctaKey: 'verification.banner.unverifiedCta', href: VERIFICATION_SETTINGS_HREF } as const;
    case VerificationStatus.PROCESSING:
      return { tone: 'info', key: 'verification.banner.pending', ctaKey: null, href: null } as const;
    case VerificationStatus.NEEDS_REVIEW:
      return { tone: 'info', key: 'verification.banner.needsReview', ctaKey: null, href: null } as const;
    case VerificationStatus.REJECTED:
      return { tone: 'danger', key: 'verification.banner.rejected', ctaKey: 'verification.banner.rejectedCta', href: VERIFICATION_SETTINGS_HREF } as const;
    default:
      return null;
  }
}
