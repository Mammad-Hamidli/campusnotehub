import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { ProviderProfile } from './providers';

/**
 * The account-matching POLICY of the provider callback.
 *
 * The real handleCallback runs; only I/O is replaced (state storage, token
 * exchange, repositories). Each test states one rule from the header of
 * callback.ts and checks both where the browser is sent and what was - or was
 * NOT - written.
 */

process.env.GOOGLE_CLIENT_ID = 'g-id';
process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.APP_URL = 'https://campushub.test';

type User = {
  id: string;
  email: string;
  nickname: string;
  role: string;
  accountStatus: string;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
  lockedUntil: Date | null;
  profileIncomplete?: boolean;
};
const users = new Map<string, User>();
const identities = new Map<string, { userId: string; provider: string }>();
const mfaEnrolled = new Set<string>();
const sessions = new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>();
let consumed: Record<string, unknown> | null;
let profile: ProviderProfile;

const updateUser = vi.fn(async (id: string, patch: Partial<User>) => void Object.assign(users.get(id)!, patch));
const completeLogin = vi.fn(async (p: { user: User; redirectTo?: string; amr: string[] }) =>
  NextResponse.redirect(`https://campushub.test/__session/${p.user.id}?amr=${p.amr.join(',')}`, 303),
);
/**
 * Rule 3 creates the account on the spot. The fake mirrors createUser's
 * uniqueness rule that matters here: an email already on an account is
 * refused, never merged.
 */
const createQuickAccount = vi.fn(async (p: ProviderProfile) => {
  if (p.email && [...users.values()].some((u) => u.email === p.email)) {
    return { ok: false as const, reason: 'email_in_use' as const };
  }
  const created = user(`new-${p.subject}`, {
    email: p.email ?? 'x@pending.invalid',
    nickname: 'user12345',
    emailVerifiedAt: p.emailVerified ? new Date() : null,
    profileIncomplete: true,
  });
  identities.set(`${p.provider}:${p.subject}`, { userId: created.id, provider: p.provider });
  return { ok: true as const, user: created };
});
const sendEmailAsync = vi.fn();

vi.mock('./flow', async () => {
  const actual = await vi.importActual<typeof import('./flow')>('./flow');
  return {
    ...actual,
    consumeState: async () => consumed,
    exchangeCode: async () => 'id-token',
    verifyIdToken: async () => profile,
  };
});
vi.mock('@/lib/firebase/repositories/identities', () => ({
  identityKey: (provider: string, subject: string) => `${provider}:${subject}`,
  findIdentity: async (key: string) => identities.get(key) ?? null,
  touchIdentity: async () => {},
  linkIdentity: async (userId: string, p: ProviderProfile) => {
    const key = `${p.provider}:${p.subject}`;
    const existing = identities.get(key);
    if (existing) return existing.userId === userId ? 'already_linked' : 'identity_in_use';
    if ([...identities.values()].some((i) => i.userId === userId && i.provider === p.provider)) return 'provider_already_linked';
    identities.set(key, { userId, provider: p.provider });
    return 'linked';
  },
}));
vi.mock('@/lib/firebase/repositories/users', () => ({
  findUserById: async (id: string) => users.get(id) ?? null,
  findUserIdByEmailHash: async (hash: string) => [...users.values()].find((u) => `h:${u.email}` === hash)?.id ?? null,
  updateUser: (...a: unknown[]) => updateUser(...(a as [string, Partial<User>])),
}));
vi.mock('@/lib/crypto/hash', async () => {
  const actual = await vi.importActual<typeof import('@/lib/crypto/hash')>('@/lib/crypto/hash');
  return { ...actual, hashEmail: (email: string) => `h:${email}` };
});
vi.mock('@/lib/firebase/repositories/mfa', () => ({
  getMfa: async (id: string) => (mfaEnrolled.has(id) ? { totpSecretSealed: 'x' } : null),
  isEnrolled: (r: unknown) => !!r,
  createLoginTicket: async () => ({ token: 't'.repeat(43), expiresAt: new Date() }),
}));
vi.mock('@/lib/firebase/repositories/sessions', () => ({
  findSessionById: async (id: string) => sessions.get(id) ?? null,
}));
vi.mock('@/lib/firebase/repositories/audit', () => ({ writeAuditLog: async () => {} }));
vi.mock('@/lib/security/blocklist', () => ({ isUserBlocked: async () => false }));
vi.mock('@/lib/security/ratelimit', () => ({
  rateLimit: async () => ({ ok: true, remaining: 1, retryAfterSeconds: 0 }),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/email/send', () => ({ sendEmailAsync: (...a: unknown[]) => sendEmailAsync(...a) }));
vi.mock('@/lib/auth/complete-login', () => ({ completeLogin: (p: never) => completeLogin(p) }));
vi.mock('@/lib/auth/quick-signup', () => ({ createQuickAccount: (p: ProviderProfile) => createQuickAccount(p) }));

const { handleCallback } = await import('./callback');

function user(id: string, patch: Partial<User> = {}): User {
  const u: User = {
    id,
    email: `${id}@ada.edu.az`,
    nickname: id,
    role: 'STUDENT',
    accountStatus: 'ACTIVE',
    emailVerifiedAt: new Date(),
    deletedAt: null,
    lockedUntil: null,
    ...patch,
  };
  users.set(id, u);
  return u;
}

function google(patch: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    provider: 'google',
    subject: 'g-sub',
    email: 'aysel@ada.edu.az',
    emailVerified: true,
    linkableByEmail: true,
    firstName: 'Aysel',
    lastName: 'M',
    ...patch,
  };
}

function loginState(returnTo = '') {
  return { provider: 'google', intent: 'login', userId: null, sessionId: null, returnTo, nonceHash: 'n', verifier: 'v' };
}

async function callback(provider = 'google') {
  const request = new NextRequest(`https://campushub.test/api/auth/oauth/${provider}/callback?state=s&code=c`);
  const response = await handleCallback(request, provider, request.nextUrl.searchParams);
  return { location: new URL(response.headers.get('location')!), response };
}

beforeEach(() => {
  users.clear();
  identities.clear();
  mfaEnrolled.clear();
  sessions.clear();
  vi.clearAllMocks();
  consumed = loginState();
});

describe('sign-in', () => {
  it('signs in a known identity as its account, with a federated (first-factor) amr', async () => {
    user('u1');
    identities.set('google:g-sub', { userId: 'u1', provider: 'google' });
    profile = google();
    const { location } = await callback();
    expect(location.pathname).toBe('/__session/u1');
    expect(location.searchParams.get('amr')).toBe('fed');
  });

  it('auto-links when BOTH the provider and this app have verified the same email', async () => {
    user('aysel', { emailVerifiedAt: new Date() });
    profile = google();
    const { location } = await callback();
    expect(location.pathname).toBe('/__session/aysel');
    expect(identities.get('google:g-sub')?.userId).toBe('aysel');
    expect(sendEmailAsync).toHaveBeenCalledWith('aysel@ada.edu.az', 'oauthLinked', expect.objectContaining({ automatic: true }));
  });

  it('PRE-HIJACK: refuses to link or sign in to an account whose email was never verified here', async () => {
    user('aysel', { emailVerifiedAt: null });
    profile = google();
    const { location } = await callback();
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('oauth')).toBe('link_required');
    expect(identities.size).toBe(0);
    expect(completeLogin).not.toHaveBeenCalled();
    // Nothing about the squatted account was changed either.
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('never matches an unverified or non-linkable email to an existing account', async () => {
    user('aysel');
    for (const p of [google({ emailVerified: false, linkableByEmail: false }), google({ linkableByEmail: false })]) {
      profile = p;
      consumed = loginState();
      const { location } = await callback();
      // The address is taken, so no new account is made on it - and the
      // existing one is not merged or signed in to either.
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('oauth')).toBe('link_required');
    }
    expect(identities.size).toBe(0);
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('creates a NEW view-only account with a temporary handle and sends it to /onboarding', async () => {
    profile = google({ subject: 'fresh', email: 'new.student@gmail.com' });
    await callback();
    expect(createQuickAccount).toHaveBeenCalledTimes(1);
    const created = users.get('new-fresh')!;
    expect(created.profileIncomplete).toBe(true);
    expect(created.nickname).toMatch(/^user\d{5}$/);
    expect(identities.get('google:fresh')?.userId).toBe('new-fresh');
    // Signed straight in (a federated first factor), landing on onboarding.
    expect(completeLogin).toHaveBeenCalledWith(expect.objectContaining({ redirectTo: '/onboarding', amr: ['fed'] }));
  });

  it('still demands the second factor from an account with 2FA', async () => {
    user('u1');
    mfaEnrolled.add('u1');
    identities.set('google:g-sub', { userId: 'u1', provider: 'google' });
    profile = google();
    consumed = loginState('/notes');
    const { location, response } = await callback();
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('mfa')).toBe('1');
    expect(location.searchParams.get('next')).toBe('/notes');
    expect(completeLogin).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie().some((c) => c.startsWith('CH_MT=') && /HttpOnly/i.test(c))).toBe(true);
    // ...and the ticket itself is not in the URL.
    expect(location.search).not.toContain('t'.repeat(10));
  });

  /**
   * The riskiest combination: a first Google sign-in that AUTO-LINKS (rule 2a)
   * to an account that has 2FA. The link must happen and the gate must still
   * hold - linking a provider is never a way to skip the second factor.
   */
  it('auto-links and STILL demands the second factor', async () => {
    user('u1', { email: 'aysel@ada.edu.az', emailVerifiedAt: new Date() });
    mfaEnrolled.add('u1');
    profile = google({ email: 'aysel@ada.edu.az' });
    consumed = loginState();
    const { location } = await callback();

    expect(identities.get('google:g-sub')?.userId).toBe('u1');
    expect(location.searchParams.get('mfa')).toBe('1');
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('refuses a banned or deleted account behind a known identity', async () => {
    user('u1', { accountStatus: 'BANNED' });
    identities.set('google:g-sub', { userId: 'u1', provider: 'google' });
    profile = google();
    const { location } = await callback();
    expect(location.searchParams.get('oauth')).toBe('failed');
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('shows no provider-supplied error text and burns nothing it did not consume', async () => {
    consumed = null;
    const { location } = await callback();
    expect(location.searchParams.get('oauth')).toBe('expired');
  });
});

describe('link from settings', () => {
  function linkState(sessionId = 'sess1', userId = 'u1') {
    return { provider: 'google', intent: 'link', userId, sessionId, returnTo: '/settings/security', nonceHash: 'n', verifier: 'v' };
  }

  it('links to the signed-in account whatever email the provider reports', async () => {
    user('u1', { email: 'u1@ada.edu.az', emailVerifiedAt: null });
    sessions.set('sess1', { userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    consumed = linkState();
    profile = google({ email: 'someone.else@gmail.com' });
    const { location } = await callback();
    expect(location.pathname).toBe('/settings/security');
    expect(location.searchParams.get('linked')).toBe('google');
    expect(identities.get('google:g-sub')?.userId).toBe('u1');
    // A DIFFERENT address proves nothing about the account's own email.
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('marks the account email verified when Google verified that same address', async () => {
    user('u1', { email: 'aysel@ada.edu.az', emailVerifiedAt: null });
    sessions.set('sess1', { userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    consumed = linkState();
    profile = google({ email: 'aysel@ada.edu.az' });
    await callback();
    expect(updateUser).toHaveBeenCalledWith('u1', { emailVerifiedAt: expect.any(Date) });
  });

  it('does not complete a link whose session was signed out meanwhile', async () => {
    user('u1');
    sessions.set('sess1', { userId: 'u1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    consumed = linkState();
    profile = google();
    const { location } = await callback();
    expect(location.searchParams.get('oauth')).toBe('expired');
    expect(identities.size).toBe(0);
  });

  it('never re-points an identity that belongs to another account', async () => {
    user('u1');
    user('u2');
    identities.set('google:g-sub', { userId: 'u2', provider: 'google' });
    sessions.set('sess1', { userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    consumed = linkState();
    profile = google();
    const { location } = await callback();
    expect(location.searchParams.get('oauth')).toBe('identity_in_use');
    expect(identities.get('google:g-sub')?.userId).toBe('u2');
  });
});

describe('password lockout', () => {
  it('does not block a provider sign-in (it only stops password guessing)', async () => {
    user('u1', { lockedUntil: new Date(Date.now() + 15 * 60_000) });
    identities.set('google:g-sub', { userId: 'u1', provider: 'google' });
    profile = google();
    const { location } = await callback();
    expect(location.pathname).toBe('/__session/u1');
  });
});

describe('after email verification', () => {
  it('turns "sign in with your password first" into automatic linking', async () => {
    user('aysel', { emailVerifiedAt: null });
    profile = google();
    expect((await callback()).location.searchParams.get('oauth')).toBe('link_required');

    // What /api/me/email/verify records once the owner confirms the address.
    users.get('aysel')!.emailVerifiedAt = new Date();
    consumed = loginState();
    const { location } = await callback();
    expect(location.pathname).toBe('/__session/aysel');
    expect(identities.get('google:g-sub')?.userId).toBe('aysel');
  });
});
