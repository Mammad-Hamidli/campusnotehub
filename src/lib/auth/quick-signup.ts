import { VerificationStatus } from '@/lib/enums';
import { hashEmail } from '@/lib/crypto/hash';
import { isLocale } from '@/lib/i18n/dictionaries';
import {
  createUser,
  newUserDefaults,
  newUserId,
  DuplicateUserError,
  type UserRecord,
} from '@/lib/firebase/repositories/users';
import { ensureWallet } from '@/lib/firebase/repositories/wallets';
import { identityData, identityKey, identityRef } from '@/lib/firebase/repositories/identities';
import { checkSignupBlocked } from '@/lib/security/blocklist';
import { PLACEHOLDER_EMAIL_DOMAIN, temporaryHandle } from './username';
import type { ProviderProfile } from './oauth/providers';

/** How many random "userNNNNN" handles to try before giving up. */
const HANDLE_ATTEMPTS = 6;

export type QuickSignupResult =
  | { ok: true; user: UserRecord }
  | { ok: false; reason: 'blocked' | 'email_in_use' | 'identity_in_use' | 'no_handle' };

/**
 * Creates an account straight from a quick login (Google).
 *
 * The account exists immediately - there is no registration form in between -
 * but it is INCOMPLETE: a temporary "user34232" handle, no university, and
 * `profileIncomplete: true`, which keeps it view-only (permissions.can) until
 * the owner finishes /onboarding. This replaces the pending-sign-up hand-off
 * to /register?via=..., which asked a person who had just clicked "Continue
 * with Google" to fill in a second full form before seeing anything.
 *
 * The identity is linked in the SAME transaction as the account (createUser),
 * so a half-created account nobody can sign in to cannot exist. Email rules
 * are unchanged from the old flow: only a provider-VERIFIED address is stored
 * as verified; an address that already belongs to another account is never
 * merged here (that is the callback's rule 2 / nOAuth - see callback.ts).
 */
export async function createQuickAccount(
  profile: ProviderProfile,
  options: { locale?: string | null } = {},
): Promise<QuickSignupResult> {
  const userId = newUserId();
  const email = profile.email ?? `${userId}@${PLACEHOLDER_EMAIL_DOMAIN}`;

  if (profile.email && (await checkSignupBlocked({ email: profile.email })).blocked) {
    return { ok: false, reason: 'blocked' };
  }

  const displayName = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
  const now = new Date();

  for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt++) {
    try {
      const user = await createUser({
        profile: {
          ...newUserDefaults(),
          id: userId,
          email,
          emailVerifiedAt: profile.email && profile.emailVerified ? now : null,
          fullName: displayName,
          firstName: profile.firstName ?? null,
          lastName: profile.lastName ?? null,
          nickname: temporaryHandle(),
          locale: options.locale && isLocale(options.locale) ? options.locale : 'az',
          verificationStatus: VerificationStatus.UNVERIFIED,
          profileIncomplete: true,
          createdAt: now,
          updatedAt: now,
        },
        credentials: { passwordHash: null, emailHash: hashEmail(email), phoneHash: null },
        identity: {
          ref: identityRef(identityKey(profile.provider, profile.subject)),
          data: identityData(profile),
        },
      });
      // Idempotent and recoverable - see the note in the register route.
      await ensureWallet(user.id);
      return { ok: true, user };
    } catch (error) {
      if (!(error instanceof DuplicateUserError)) throw error;
      if (error.field === 'nickname') continue; // another random handle
      if (error.field === 'identity') return { ok: false, reason: 'identity_in_use' };
      return { ok: false, reason: 'email_in_use' };
    }
  }
  return { ok: false, reason: 'no_handle' };
}
