import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import type { UserRecord } from '@/lib/firebase/repositories/users';

/**
 * completeLogin is the one place a provider photo may be imported from a
 * sign-in: only after the session exists, so neither a pending second factor
 * nor a failed sign-in can ever change a profile.
 */

const PHOTO = 'https://lh3.googleusercontent.com/a/admin-photo=s96-c';
const order: string[] = [];

const issueSession = vi.fn(async () => {
  order.push('session');
  return { applyCookies: (response: NextResponse) => response };
});
const importProviderAvatarAsync = vi.fn<(userId: string, picture: string) => void>(() => void order.push('import'));

vi.mock('@/lib/firebase/repositories/users', () => ({ updateUser: async () => {} }));
vi.mock('@/lib/firebase/repositories/audit', () => ({ writeAuditLog: async () => {} }));
vi.mock('@/lib/security/blocklist', () => ({ recordDeviceDetailed: async () => ({ id: 'd1', created: false }) }));
vi.mock('@/lib/security/fingerprint', () => ({ deviceLabel: () => 'Chrome on Windows' }));
vi.mock('@/lib/email/send', () => ({ sendEmailAsync: () => {} }));
vi.mock('@/lib/auth/session', () => ({
  issueSession: () => issueSession(),
  sessionClientOf: () => 'web',
  sessionHasMfa: (amr: string[]) => amr.includes('otp'),
}));
vi.mock('@/lib/media/import-avatar', () => ({
  importProviderAvatarAsync: (userId: string, picture: string) => importProviderAvatarAsync(userId, picture),
}));

const { completeLogin } = await import('./complete-login');

const admin = {
  id: 'admin1',
  email: 'admin@campusnotehub.test',
  nickname: 'campus_admin',
  role: 'ADMIN',
  accountStatus: 'ACTIVE',
  verificationStatus: 'VERIFIED',
  mentorSince: null,
} as unknown as UserRecord;

const signIn = (providerPicture?: string | null) =>
  completeLogin({
    request: new NextRequest('http://localhost/api/auth/mfa/verify', { headers: { 'user-agent': 'Mozilla/5.0 test' } }),
    user: admin,
    amr: ['fed', 'otp'],
    mfaAt: new Date(),
    method: 'fed+totp',
    providerPicture,
  });

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe('completeLogin - provider photo', () => {
  it('starts the import only once the session has been issued', async () => {
    const response = await signIn(PHOTO);
    expect(response.status).toBe(200);
    expect(importProviderAvatarAsync).toHaveBeenCalledWith('admin1', PHOTO);
    expect(order).toEqual(['session', 'import']);
  });

  it('imports nothing when there is no photo to copy', async () => {
    await signIn(null);
    await signIn(undefined);
    expect(importProviderAvatarAsync).not.toHaveBeenCalled();
  });

  it('a photo import that cannot start never fails the sign-in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    importProviderAvatarAsync.mockImplementationOnce(() => {
      throw new Error('image pipeline failed to load');
    });
    expect((await signIn(PHOTO)).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not started'), 'image pipeline failed to load');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('googleusercontent');
    warn.mockRestore();
  });

  it('imports nothing when the session could not be issued', async () => {
    issueSession.mockRejectedValueOnce(new Error('firestore unavailable'));
    await expect(signIn(PHOTO)).rejects.toThrow('firestore unavailable');
    expect(importProviderAvatarAsync).not.toHaveBeenCalled();
  });
});
