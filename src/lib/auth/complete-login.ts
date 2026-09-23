import { NextResponse, type NextRequest } from 'next/server';
import { UserRole } from '@/lib/enums';
import { updateUser, type UserRecord } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { recordDeviceDetailed } from '@/lib/security/blocklist';
import { deviceLabel } from '@/lib/security/fingerprint';
import { sendEmailAsync } from '@/lib/email/send';
import { issueSession, sessionHasMfa } from '@/lib/auth/session';
import { browserOrigin, flowOrigin } from '@/lib/app-url';

/**
 * The last step of every successful sign-in: device bookkeeping, the session,
 * the audit row and the post-login destination.
 *
 * Shared by POST /api/auth/login (accounts without a second factor) and
 * POST /api/auth/mfa/verify (accounts with one), so the two paths cannot drift
 * apart - a new-device email that only one of them sends is exactly the kind
 * of gap that goes unnoticed. Everything that must happen BEFORE a session
 * exists (password check, lockout, status checks, the second factor) stays in
 * the routes; nothing here decides whether the user may sign in.
 */
export async function completeLogin(params: {
  request: NextRequest;
  user: UserRecord;
  deviceFingerprint?: string | null;
  amr: string[];
  mfaAt: Date | null;
  /** Audit label, e.g. 'email_password' or 'username_password+otp'. */
  method: string;
  /** Extra fields for the JSON body, e.g. how many recovery codes are left. */
  extra?: Record<string, unknown>;
  /**
   * Answer with a 303 redirect instead of JSON - for a provider callback,
   * which is a browser navigation, not a fetch. The value is the requested
   * destination; it must already be a validated same-origin path.
   */
  redirectTo?: string;
}): Promise<NextResponse> {
  const { request, user } = params;
  const userAgent = request.headers.get('user-agent') ?? '';

  /**
   * The password-guessing counter is cleared only by a PASSWORD sign-in.
   * Letting a Google sign-in reset it would hand whoever is guessing
   * the password a fresh allowance every time the owner signs in another way.
   */
  await updateUser(user.id, {
    lastLoginAt: new Date(),
    ...(params.amr.includes('pwd') ? { failedLoginCount: 0, lockedUntil: null } : {}),
  });

  const device = params.deviceFingerprint
    ? await recordDeviceDetailed({
        userId: user.id,
        fingerprint: params.deviceFingerprint,
        label: deviceLabel(userAgent || undefined),
      })
    : undefined;

  // First sign-in from this device (registration records the device it was
  // created on, so a normal login there is not "new").
  if (device?.created) {
    sendEmailAsync(user.email, 'newDeviceLogin', {
      nickname: user.nickname,
      device: deviceLabel(userAgent || undefined),
      when: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    });
  }

  const session = await issueSession({
    user: {
      id: user.id,
      role: user.role,
      accountStatus: user.accountStatus,
      verificationStatus: user.verificationStatus,
    },
    userAgent,
    deviceId: device?.id,
    amr: params.amr,
    mfaAt: params.mfaAt,
  });

  await writeAuditLog({
    actorId: user.id,
    action: 'USER_LOGIN',
    entityType: 'user',
    entityId: user.id,
    deviceFingerprint: params.deviceFingerprint ?? undefined,
    userAgent: userAgent.slice(0, 512) || undefined,
    result: 'SUCCESS',
    // How, never with what: the identifier itself stays out of the trail.
    after: { method: params.method, amr: params.amr },
  });

  /**
   * Where this account belongs after signing in, decided HERE rather than on
   * the client: the access token carries no role claim, so the browser cannot
   * know. The client treats it as a default, not as authorization - /admin is
   * still guarded by its own layout and by every /api/admin handler.
   *
   * Staff who signed in without a second factor are sent to set one up: the
   * panel would refuse them (requireSession withholds the role), and landing
   * on the student feed instead reads as "my admin access disappeared".
   */
  const isStaff = user.role === UserRole.ADMIN || user.role === UserRole.MODERATOR;
  const href = !isStaff
    ? '/dashboard'
    : sessionHasMfa(params.amr)
      ? '/admin'
      : '/settings/security?mfa=required';

  if (params.redirectTo !== undefined) {
    // Staff owed a second factor go to set it up whatever was requested; the
    // panel would refuse them anyway.
    const target = isStaff && !sessionHasMfa(params.amr) ? href : params.redirectTo || href;
    const response = NextResponse.redirect(new URL(target, flowOrigin(browserOrigin(request)) ?? request.url), 303);
    session.applyCookies(response);
    return response;
  }

  const response = NextResponse.json({
    user: { id: user.id, role: user.role, verificationStatus: user.verificationStatus },
    next: { href },
    ...params.extra,
  });
  session.applyCookies(response);
  return response;
}
