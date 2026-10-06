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
process.env.APP_URL = 'https://campusnotehub.test';

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
  passwordSetupRequired?: boolean;
  avatarUrl?: string | null;
  avatarRemovedAt?: Date | null;
};
const users = new Map<string, User>();
/** Accounts that have never had a password (Google-only). Everyone else has one. */
const passwordless = new Set<string>();
const identities = new Map<string, { userId: string; provider: string }>();
const mfaEnrolled = new Set<string>();
const sessions = new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>();
let consumed: Record<string, unknown> | null;
let profile: ProviderProfile;
let tokens: { idToken: string; refreshToken: string | null; scope: string };
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const saveCalendarLink = vi.fn(async () => ({ replacedToken: null as string | null }));
const revokeGoogleToken = vi.fn(async () => {});
const provisionWaitingMeetings = vi.fn(async () => {});

const updateUser = vi.fn(async (id: string, patch: Partial<User>) => void Object.assign(users.get(id)!, patch));
const completeLogin = vi.fn(async (p: { user: User; redirectTo?: string; amr: string[] }) =>
  NextResponse.redirect(`https://campusnotehub.test/__session/${p.user.id}?amr=${p.amr.join(',')}`, 303),
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
type TicketParams = { userId: string; providerPicture?: string | null };
const createLoginTicket = vi.fn<(p: TicketParams) => Promise<{ token: string; expiresAt: Date }>>(async () => ({
  token: 't'.repeat(43),
  expiresAt: new Date(),
}));
const importProviderAvatarAsync = vi.fn();

vi.mock('./flow', async () => {
  const actual = await vi.importActual<typeof import('./flow')>('./flow');
  return {
    ...actual,
    consumeState: async () => consumed,
    exchangeCode: async () => 'id-token',
    exchangeTokens: async () => tokens,
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
  getCredentials: async (id: string) => ({ id, passwordHash: passwordless.has(id) ? null : '$argon2id$x' }),
  // The real rule with the default 7-day cool-down.
  identifiersReleaseAt: (u: User) => (u.deletedAt ? new Date(u.deletedAt.getTime() + 7 * 86_400_000) : null),
  identifiersReleased: (u: User) => !!u.deletedAt && u.deletedAt.getTime() + 7 * 86_400_000 <= Date.now(),
}));
vi.mock('@/lib/crypto/hash', async () => {
  const actual = await vi.importActual<typeof import('@/lib/crypto/hash')>('@/lib/crypto/hash');
  return { ...actual, hashEmail: (email: string) => `h:${email}` };
});
vi.mock('@/lib/firebase/repositories/mfa', () => ({
  getMfa: async (id: string) => (mfaEnrolled.has(id) ? { totpSecretSealed: 'x' } : null),
  isEnrolled: (r: unknown) => !!r,
  createLoginTicket: (p: { userId: string }) => createLoginTicket(p),
}));
vi.mock('@/lib/media/import-avatar', () => ({
  importProviderAvatarAsync: (...a: unknown[]) => importProviderAvatarAsync(...a),
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
vi.mock('@/lib/firebase/repositories/calendarLinks', () => ({
  saveCalendarLink: (...a: unknown[]) => saveCalendarLink(...(a as [])),
  maskAddress: (email: string | null) => (email ? `${email.slice(0, 2)}***` : null),
}));
vi.mock('@/lib/google/calendar', () => ({
  CALENDAR_SCOPE,
  forgetAccessToken: () => {},
  revokeGoogleToken: (...a: unknown[]) => revokeGoogleToken(...(a as [])),
}));
vi.mock('@/lib/mentors/meeting', () => ({
  provisionWaitingMeetings: (...a: unknown[]) => provisionWaitingMeetings(...(a as [])),
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
    picture: null,
    ...patch,
  };
}

function loginState(returnTo = '') {
  return { provider: 'google', intent: 'login', userId: null, sessionId: null, returnTo, nonceHash: 'n', verifier: 'v' };
}

async function callback(provider = 'google') {
  const request = new NextRequest(`https://campusnotehub.test/api/auth/oauth/${provider}/callback?state=s&code=c`);
  const response = await handleCallback(request, provider, request.nextUrl.searchParams);
  return { location: new URL(response.headers.get('location')!), response };
}

beforeEach(() => {
  users.clear();
  identities.clear();
  mfaEnrolled.clear();
  passwordless.clear();
  sessions.clear();
  vi.clearAllMocks();
  consumed = loginState();
  tokens = { idToken: 'id-token', refreshToken: null, scope: 'openid email profile' };
});

describe('sign-in', () => {
  it('a deleted account inside its cool-down keeps its Google sign-in, and says until when', async () => {
    const deletedAt = new Date(Date.now() - 86_400_000);
    user('gone', { deletedAt, accountStatus: 'DELETED' });
    identities.set('google:g-sub', { userId: 'gone', provider: 'google' });
    profile = google();
    const { location } = await callback();
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('oauth')).toBe('account_deleted');
    expect(location.searchParams.get('until')).toBe(new Date(deletedAt.getTime() + 7 * 86_400_000).toISOString().slice(0, 10));
    expect(createQuickAccount).not.toHaveBeenCalled();
  });

  it('an identity left behind by an account that no longer exists signs up afresh instead of failing', async () => {
    identities.set('google:g-sub', { userId: 'hard-deleted', provider: 'google' });
    profile = google();
    const { location } = await callback();
    expect(createQuickAccount).toHaveBeenCalled();
    expect(location.pathname).toBe('/__session/new-g-sub');
  });

  it('a deleted account past its cool-down no longer holds the Google sign-in', async () => {
    user('gone', { deletedAt: new Date(Date.now() - 8 * 86_400_000), accountStatus: 'DELETED', email: 'old@x.az' });
    identities.set('google:g-sub', { userId: 'gone', provider: 'google' });
    profile = google();
    await callback();
    expect(createQuickAccount).toHaveBeenCalled();
  });

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

describe('owed local password', () => {
  it('sends a Google-only account to /set-password and flags it until one is set', async () => {
    user('u1');
    passwordless.add('u1');
    identities.set('google:g-sub', { userId: 'u1', provider: 'google' });
    profile = google();
    consumed = loginState('/notes');
    await callback();
    expect(updateUser).toHaveBeenCalledWith('u1', { passwordSetupRequired: true });
    expect(completeLogin).toHaveBeenCalledWith(expect.objectContaining({ redirectTo: '/set-password' }));
  });

  it('flags it BEFORE the 2FA step, so the code does not skip the password', async () => {
    user('u1');
    passwordless.add('u1');
    mfaEnrolled.add('u1');
    identities.set('google:g-sub', { userId: 'u1', provider: 'google' });
    profile = google();
    const { location } = await callback();
    expect(location.searchParams.get('mfa')).toBe('1');
    expect(users.get('u1')!.passwordSetupRequired).toBe(true);
  });

  it('leaves accounts with a password alone', async () => {
    user('u1');
    identities.set('google:g-sub', { userId: 'u1', provider: 'google' });
    profile = google();
    consumed = loginState('/notes');
    await callback();
    expect(updateUser).not.toHaveBeenCalledWith('u1', { passwordSetupRequired: true });
    expect(completeLogin).toHaveBeenCalledWith(expect.objectContaining({ redirectTo: '/notes' }));
  });
});

describe('provider photo for an account that has none', () => {
  const PHOTO = 'https://lh3.googleusercontent.com/a/admin-photo=s96-c';

  beforeEach(() => {
    // A bootstrapped admin: never created by a Google sign-in, no picture.
    user('admin1', { role: 'ADMIN' });
    identities.set('google:g-sub', { userId: 'admin1', provider: 'google' });
    profile = google({ picture: PHOTO });
  });

  it('without 2FA: hands the vetted photo to completeLogin, which imports it once the session exists', async () => {
    await callback();
    expect(completeLogin).toHaveBeenCalledWith(expect.objectContaining({ providerPicture: PHOTO }));
    // Not imported on the provider's word here - that is completeLogin's job.
    expect(importProviderAvatarAsync).not.toHaveBeenCalled();
  });

  it('with 2FA: imports NOTHING before the code - the photo waits in the login ticket', async () => {
    mfaEnrolled.add('admin1');
    const { location } = await callback();
    expect(location.searchParams.get('mfa')).toBe('1');
    expect(createLoginTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin1', providerPicture: PHOTO }));
    expect(completeLogin).not.toHaveBeenCalled();
    expect(importProviderAvatarAsync).not.toHaveBeenCalled();
    // The URL never reaches the browser.
    expect(location.href).not.toContain('googleusercontent');
  });

  it('never for an account with a picture, a removed one, or one a Google sign-in created', async () => {
    for (const patch of [
      { avatarUrl: '/api/media/mine' },
      { avatarRemovedAt: new Date() },
      { profileIncomplete: false },
    ]) {
      Object.assign(users.get('admin1')!, { avatarUrl: null, avatarRemovedAt: null, profileIncomplete: undefined }, patch);
      completeLogin.mockClear();
      consumed = loginState();
      await callback();
      expect(completeLogin, JSON.stringify(patch)).toHaveBeenCalledWith(expect.objectContaining({ providerPicture: null }));
    }
  });

  it('never carries a URL outside the photo-host allowlist', async () => {
    mfaEnrolled.add('admin1');
    profile = google({ picture: 'https://evil.example/tracker.png' });
    await callback();
    expect(createLoginTicket).toHaveBeenCalledWith(expect.objectContaining({ providerPicture: null }));
  });

  it('linking from settings imports at once: the session behind it is already live', async () => {
    identities.clear();
    sessions.set('sess1', { userId: 'admin1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    consumed = { provider: 'google', intent: 'link', userId: 'admin1', sessionId: 'sess1', returnTo: '/settings/security', nonceHash: 'n', verifier: 'v' };
    await callback();
    expect(importProviderAvatarAsync).toHaveBeenCalledWith('admin1', PHOTO);
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

describe('Google Calendar connection (mentor panel)', () => {
  function calendarState() {
    sessions.set('s1', { userId: 'm1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    return { provider: 'google', intent: 'calendar', userId: 'm1', sessionId: 's1', returnTo: '/mentors/dashboard', nonceHash: 'n', verifier: 'v' };
  }

  beforeEach(() => {
    user('m1', { role: 'MENTOR' });
    consumed = calendarState();
    profile = google({ subject: 'g-cal', email: 'mentor@gmail.com' });
    tokens = { idToken: 'id-token', refreshToken: 'refresh-1', scope: `openid ${CALENDAR_SCOPE} email` };
  });

  it('stores the grant for the session user and signs nobody in', async () => {
    const { location } = await callback();
    expect(location.pathname).toBe('/mentors/dashboard');
    expect(location.searchParams.get('calendar')).toBe('connected');
    expect(saveCalendarLink).toHaveBeenCalledWith('m1', expect.objectContaining({ refreshToken: 'refresh-1', googleSubject: 'g-cal' }));
    expect(completeLogin).not.toHaveBeenCalled();
    expect(identities.size).toBe(0);
    expect(sendEmailAsync).toHaveBeenCalledWith('m1@ada.edu.az', 'calendarConnected', expect.anything());
  });

  it('refuses a grant without calendar access, and revokes what it was given', async () => {
    tokens = { ...tokens, scope: 'openid email' };
    const { location } = await callback();
    expect(location.searchParams.get('oauth')).toBe('calendar_scope_missing');
    expect(saveCalendarLink).not.toHaveBeenCalled();
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-1');
  });

  it('refuses an account that is not a mentor', async () => {
    users.get('m1')!.role = 'STUDENT';
    const { location } = await callback();
    expect(location.searchParams.get('oauth')).toBe('forbidden');
    expect(saveCalendarLink).not.toHaveBeenCalled();
  });

  it('does not complete when the starting session was signed out meanwhile', async () => {
    sessions.get('s1')!.revokedAt = new Date();
    const { location } = await callback();
    expect(location.searchParams.get('oauth')).toBe('expired');
    expect(saveCalendarLink).not.toHaveBeenCalled();
  });

  it('revokes the token a reconnect replaced', async () => {
    saveCalendarLink.mockResolvedValueOnce({ replacedToken: 'refresh-0' });
    await callback();
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-0');
  });
});
