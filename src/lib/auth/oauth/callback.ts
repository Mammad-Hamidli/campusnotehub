import type { NextRequest, NextResponse } from 'next/server';
import { AccountStatus } from '@/lib/enums';
import { hashEmail } from '@/lib/crypto/hash';
import { findSessionById } from '@/lib/firebase/repositories/sessions';
import {
  findUserById,
  findUserIdByEmailHash,
  getCredentials,
  identifiersReleaseAt,
  identifiersReleased,
  updateUser,
  type UserRecord,
} from '@/lib/firebase/repositories/users';
import { createLoginTicket, getMfa, isEnrolled } from '@/lib/firebase/repositories/mfa';
import {
  findIdentity,
  identityKey,
  linkIdentity,
  touchIdentity,
} from '@/lib/firebase/repositories/identities';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { isUserBlocked } from '@/lib/security/blocklist';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { sendEmailAsync } from '@/lib/email/send';
import { completeLogin } from '@/lib/auth/complete-login';
import { setMfaTicketCookie } from '@/lib/auth/mfa-http';
import { createQuickAccount } from '@/lib/auth/quick-signup';
import { LOCALE_COOKIE } from '@/lib/i18n/dictionaries';
import { BINDING_COOKIE, consumeState, exchangeCode, verifyIdToken, type ConsumedState } from './flow';
import { OAuthError, PROVIDER_LABELS, isProviderId, providerConfig, type ProviderProfile } from './providers';
import { clearBindingCookie, outcomeRedirect, redirectTo } from './http';

/**
 * The provider callback: from "the provider says this is account X" to a
 * session, a link, or a new (incomplete) account.
 *
 * ===========================================================================
 * HOW AN IDENTITY IS MATCHED TO AN ACCOUNT - THE WHOLE POLICY
 * ===========================================================================
 *  1. Known identity (provider + subject already linked)  -> that account.
 *  2. Unknown identity, and the provider VERIFIED an email that belongs to an
 *     existing account:
 *       a. account email verified here too  -> link automatically, then sign
 *          in. Both sides have proven the same mailbox, so they are the same
 *          person.
 *       b. account email NOT verified here  -> no link, no sign-in. Answer
 *          "sign in with your password, then connect <provider> in Settings".
 *  3. Anything else -> a NEW account, created on the spot with a temporary
 *     handle and view-only until /onboarding is completed. Never a match by
 *     email.
 *
 * WHY 2b REFUSES INSTEAD OF MERGING. An unverified local email proves nothing
 * about who registered it. If it was a squatter (the "pre-hijack" attack:
 * register the victim's address first, wait for them to arrive with Google),
 * auto-linking would give the victim an account the squatter set up - and on
 * this platform an account carries a verified IDENTITY from KYC documents, so
 * the victim would be operating under someone else's verified identity while
 * the squatter kept their password. Wiping the squatter's password (the usual
 * mitigation) still leaves that identity problem. Refusing does not: the real
 * owner either knows the password and links explicitly (proving both), or
 * does not and goes through support. Telling them the account exists is no
 * leak - the provider has just proven the address is theirs.
 *
 * Step 2 is reachable only with `linkableByEmail`, which Google sets only for
 * an `email_verified: true` address. An unverified Google address never
 * matches an existing account by email; it falls through to rule 3.
 *
 * Every rule above ALSO applies to an account with 2FA: a provider sign-in is
 * a first factor, and an enrolled account still owes its code (a login ticket,
 * exactly like a password sign-in). Linking Google is never a way around 2FA.
 */

type Fields = { get(name: string): string | null };

/**
 * Deliberately NOT checked: `lockedUntil`. That lock exists to stop password
 * GUESSING, and a provider sign-in is not a password attempt. Honouring it
 * here would let anyone who knows a public @handle lock its owner out of every
 * sign-in method by typing wrong passwords (product decision, 2026-09-22).
 */
function usable(user: UserRecord | null): user is UserRecord {
  return (
    !!user &&
    !user.deletedAt &&
    user.accountStatus !== AccountStatus.BANNED &&
    user.accountStatus !== AccountStatus.DELETED
  );
}

async function audit(
  request: NextRequest,
  action: string,
  userId: string | null,
  result: 'SUCCESS' | 'FAILURE' | 'DENIED',
  after: Record<string, unknown>,
) {
  await writeAuditLog({
    actorId: userId,
    action,
    entityType: 'user',
    entityId: userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    result,
    after,
  });
}

export async function handleCallback(request: NextRequest, providerParam: string, fields: Fields): Promise<NextResponse> {
  const limit = await rateLimit('auth:oauth:callback', { ip: clientIp(request.headers) });
  if (!limit.ok) return outcomeRedirect(request, '/login', 'rate_limited');

  const config = isProviderId(providerParam) ? providerConfig(providerParam) : null;
  if (!config) return outcomeRedirect(request, '/login', 'unavailable');

  const userAgent = request.headers.get('user-agent') ?? '';

  // Burned first, before even looking at `error`: whatever happens next, this
  // state can never be used again.
  const state = await consumeState({
    state: fields.get('state'),
    provider: config.id,
    binding: request.cookies.get(BINDING_COOKIE)?.value,
    userAgent,
  });
  if (!state) return outcomeRedirect(request, '/login', 'expired');

  const page = state.intent === 'link' ? '/settings/security' : '/login';

  // The provider's error TEXT is never shown - it arrives in the URL and is
  // attacker-controllable. Only the fact of cancellation is used.
  const providerError = fields.get('error');
  if (providerError) {
    const cancelled = providerError === 'access_denied' || providerError === 'user_cancelled_authorize';
    return outcomeRedirect(request, page, cancelled ? 'cancelled' : 'failed');
  }

  const code = fields.get('code');
  if (!code) return outcomeRedirect(request, page, 'failed');

  let profile: ProviderProfile;
  try {
    const idToken = await exchangeCode(config, state, code);
    profile = await verifyIdToken(config, idToken, state.nonceHash);
  } catch (error) {
    const reason = error instanceof OAuthError ? error.message : 'unexpected';
    console.warn(`[oauth] ${config.id} callback rejected: ${reason}`);
    await audit(request, 'OAUTH_CALLBACK', state.userId, 'FAILURE', { provider: config.id, reason });
    return outcomeRedirect(request, page, 'failed');
  }

  return state.intent === 'link' ? handleLink(request, state, profile) : handleLogin(request, state, profile, userAgent);
}

// ---------------------------------------------------------------------------

async function handleLink(request: NextRequest, state: ConsumedState, profile: ProviderProfile) {
  const page = '/settings/security' as const;

  // The session that started the link must still be alive and still be the
  // same user's. A link started, then signed out of, must not complete.
  const session = state.sessionId ? await findSessionById(state.sessionId) : null;
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.userId !== state.userId) {
    return outcomeRedirect(request, page, 'expired');
  }
  const user = await findUserById(session.userId);
  if (!usable(user) || (await isUserBlocked(user.id))) return outcomeRedirect(request, page, 'expired');

  const result = await linkIdentity(user.id, profile);
  await audit(request, 'OAUTH_LINK', user.id, result === 'linked' || result === 'already_linked' ? 'SUCCESS' : 'DENIED', {
    provider: profile.provider,
    result,
  });

  if (result === 'identity_in_use' || result === 'provider_already_linked') {
    return outcomeRedirect(request, page, result, { provider: profile.provider });
  }

  if (result === 'linked') {
    /**
     * A bonus, not a condition: if Google verified the SAME address the
     * account already uses, that address is now proven, which later lets
     * rule 2a link that provider automatically. Never for a different address.
     */
    if (profile.linkableByEmail && profile.email === user.email.toLowerCase() && !user.emailVerifiedAt) {
      await updateUser(user.id, { emailVerifiedAt: new Date() });
    }
    sendEmailAsync(user.email, 'oauthLinked', {
      nickname: user.nickname,
      provider: PROVIDER_LABELS[profile.provider],
      automatic: false,
    });
  }

  return clearBindingCookie(redirectTo(request, `${page}?linked=${profile.provider}`));
}

/**
 * A deleted account still inside its cool-down keeps its Google sign-in and
 * email; the person is told when they free up (see identifiersReleaseAt).
 * The provider has just proven the address is theirs, so the date is no leak.
 */
async function deletedAccountRedirect(request: NextRequest, owner: UserRecord, provider: string) {
  await audit(request, 'OAUTH_LOGIN', owner.id, 'DENIED', { provider, reason: 'account_deleted' });
  const until = identifiersReleaseAt(owner)!.toISOString().slice(0, 10);
  return outcomeRedirect(request, '/login', 'account_deleted', { until });
}

/** Deleted, and still inside the cool-down. */
const coolingDown = (user: UserRecord | null): boolean => !!user?.deletedAt && !identifiersReleased(user);

async function handleLogin(request: NextRequest, state: ConsumedState, profile: ProviderProfile, userAgent: string) {
  const key = identityKey(profile.provider, profile.subject);
  const identity = await findIdentity(key);
  let userId: string | null = null;
  let autoLinked = false;

  /**
   * An identity leads to its account - unless that account is deleted. Inside
   * the cool-down the answer is "deleted, free again on <date>". After it, or
   * when the account document is gone altogether (deleted by hand, leaving the
   * identity behind), the identity is leftover state: the sign-in carries on
   * as if Google had never been seen here, and rule 3 re-uses the identity.
   * Following a leftover to a missing account used to answer "failed" forever.
   */
  if (identity) {
    const owner = await findUserById(identity.userId);
    if (coolingDown(owner)) return deletedAccountRedirect(request, owner!, profile.provider);
    if (owner && !owner.deletedAt) userId = owner.id;
  }

  if (!userId && profile.linkableByEmail && profile.email) {
    const existingId = await findUserIdByEmailHash(hashEmail(profile.email));
    const existing = existingId ? await findUserById(existingId) : null;
    if (coolingDown(existing)) return deletedAccountRedirect(request, existing!, profile.provider);
    // A released or orphaned address is nobody's: straight on to rule 3.
    if (existing && !existing.deletedAt) {
      if (!usable(existing)) return outcomeRedirect(request, '/login', 'failed');

      if (!existing.emailVerifiedAt) {
        // Rule 2b - see the header.
        await audit(request, 'OAUTH_LINK_REQUIRED', existing.id, 'DENIED', { provider: profile.provider });
        return outcomeRedirect(request, '/login', 'link_required', { provider: profile.provider });
      }

      // Rule 2a.
      const result = await linkIdentity(existing.id, profile);
      if (result === 'provider_already_linked') {
        return outcomeRedirect(request, '/login', 'provider_already_linked', { provider: profile.provider });
      }
      if (result !== 'linked' && result !== 'already_linked') return outcomeRedirect(request, '/login', 'failed');
      userId = existing.id;
      autoLinked = result === 'linked';
    }
  }

  /**
   * Rule 3: nobody to sign in - create the account now.
   *
   * It starts INCOMPLETE (temporary "user34232" handle, view-only) and the
   * person is sent straight to /onboarding to finish it. See quick-signup.ts.
   */
  if (!userId) {
    const created = await createQuickAccount(profile, { locale: request.cookies.get(LOCALE_COOKIE)?.value });
    await audit(request, 'OAUTH_SIGNUP', created.ok ? created.user.id : null, created.ok ? 'SUCCESS' : 'DENIED', {
      provider: profile.provider,
      ...(created.ok ? {} : { reason: created.reason }),
    });
    if (!created.ok) {
      // An address that already has an account here is never merged by a
      // sign-up (rule 2 / nOAuth): the owner signs in and links explicitly.
      return created.reason === 'email_in_use'
        ? outcomeRedirect(request, '/login', 'link_required', { provider: profile.provider })
        : outcomeRedirect(request, '/login', 'failed');
    }
    const response = await completeLogin({
      request,
      user: created.user,
      amr: ['fed'],
      mfaAt: null,
      method: `oauth_${profile.provider}_signup`,
      redirectTo: '/onboarding',
    });
    response.headers.set('Referrer-Policy', 'no-referrer');
    return clearBindingCookie(response);
  }

  const user = await findUserById(userId);
  if (!usable(user) || (await isUserBlocked(user.id))) {
    await audit(request, 'OAUTH_LOGIN', userId, 'DENIED', { provider: profile.provider });
    return outcomeRedirect(request, '/login', 'failed');
  }
  if (identity) void touchIdentity(key).catch(() => {});

  if (autoLinked) {
    await audit(request, 'OAUTH_AUTO_LINKED', user.id, 'SUCCESS', { provider: profile.provider });
    sendEmailAsync(user.email, 'oauthLinked', {
      nickname: user.nickname,
      provider: PROVIDER_LABELS[profile.provider],
      automatic: true,
    });
  }

  const [mfa, credential] = await Promise.all([getMfa(user.id), getCredentials(user.id)]);

  /**
   * A Google-only account that finished its profile before a local password
   * was required owes one now. It is flagged here - the one way such an
   * account signs in - BEFORE the 2FA branch, so the flag is already set when
   * the code is entered. requirePageSession() then sends every page to
   * /set-password, and can() keeps the account view-only until
   * setInitialPassword() clears it. An incomplete profile sets its password
   * at /onboarding instead.
   */
  const owesPassword = user.profileIncomplete !== true && typeof credential?.passwordHash !== 'string';
  if (owesPassword && user.passwordSetupRequired !== true) {
    await updateUser(user.id, { passwordSetupRequired: true });
  }

  // 'fed' (RFC 8176: federated) is a FIRST factor. It does not satisfy the
  // staff MFA gate, and an enrolled account still owes its code.
  const amr = ['fed'];
  if (isEnrolled(mfa)) {
    const ticket = await createLoginTicket({ userId: user.id, userAgent, amr });
    const next = state.returnTo ? `&next=${encodeURIComponent(state.returnTo)}` : '';
    const response = redirectTo(request, `/login?mfa=1${next}`);
    setMfaTicketCookie(response, ticket.token);
    return clearBindingCookie(response);
  }

  const response = await completeLogin({
    request,
    user,
    amr,
    mfaAt: null,
    method: `oauth_${profile.provider}`,
    redirectTo: owesPassword ? '/set-password' : state.returnTo,
  });
  response.headers.set('Referrer-Policy', 'no-referrer');
  return clearBindingCookie(response);
}
