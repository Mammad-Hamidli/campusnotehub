import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * The provider photo that waited in a login ticket reaches completeLogin -
 * which imports it - only on a PROVEN second factor and an account that is
 * still allowed in. The ticket repository itself (sealing, single use) is
 * tested in repositories/mfa.test.ts; here only its result is supplied.
 */

const PHOTO = 'https://lh3.googleusercontent.com/a/admin-photo=s96-c';

type Redeemed = Record<string, unknown>;
let redeemed: Redeemed;
let account: Record<string, unknown> | null;
const completeLogin = vi.fn<(p: Record<string, unknown>) => Promise<NextResponse>>(async () =>
  NextResponse.json({ ok: true }),
);

vi.mock('@/lib/firebase/repositories/mfa', () => ({ redeemLoginTicket: async () => redeemed }));
vi.mock('@/lib/firebase/repositories/users', () => ({ findUserById: async () => account }));
vi.mock('@/lib/firebase/repositories/audit', () => ({ writeAuditLog: async () => {} }));
vi.mock('@/lib/security/blocklist', () => ({ isUserBlocked: async () => false }));
vi.mock('@/lib/security/ratelimit', () => ({
  clientIp: () => '203.0.113.1',
  peekRateLimit: async () => ({ ok: true, retryAfterSeconds: 0 }),
  rateLimit: async () => ({ ok: true, retryAfterSeconds: 0 }),
}));
vi.mock('@/lib/auth/complete-login', () => ({ completeLogin: (p: Record<string, unknown>) => completeLogin(p) }));
vi.mock('@/lib/auth/mfa-http', () => ({
  MFA_TICKET_COOKIE: 'CH_MT',
  clearMfaTicketCookie: (response: NextResponse) => response,
  mfaJson: (body: unknown, status = 200) => NextResponse.json(body, { status }),
  notifyRecoveryCodeUsed: async () => {},
}));

const { POST } = await import('./route');

const verify = () =>
  POST(
    new NextRequest('http://localhost/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 test' },
      body: JSON.stringify({ ticket: 't'.repeat(43), code: '123456' }),
    }),
  );

beforeEach(() => {
  completeLogin.mockClear();
  account = { id: 'admin1', role: 'ADMIN', accountStatus: 'ACTIVE', deletedAt: null, lockedUntil: null };
  redeemed = {
    ok: true,
    userId: 'admin1',
    amr: ['fed', 'otp'],
    method: 'totp',
    deviceFingerprint: null,
    recoveryCodesRemaining: 8,
    providerPicture: PHOTO,
  };
});

describe('POST /api/auth/mfa/verify - provider photo', () => {
  it('passes the ticket photo to completeLogin once the second factor is proven', async () => {
    const response = await verify();
    expect(response.status).toBe(200);
    expect(completeLogin).toHaveBeenCalledWith(
      expect.objectContaining({ providerPicture: PHOTO, amr: ['fed', 'otp'], mfaAt: expect.any(Date) }),
    );
  });

  it('a wrong code completes nothing, so nothing is imported', async () => {
    redeemed = { ok: false, reason: 'invalid', userId: 'admin1' };
    expect((await verify()).status).toBe(401);
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('an account banned while the code was pending gets no session and no photo', async () => {
    account = { ...account!, accountStatus: 'BANNED' };
    expect((await verify()).status).toBe(401);
    expect(completeLogin).not.toHaveBeenCalled();
  });
});
