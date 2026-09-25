import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { completeProfile, findUserById } from '@/lib/firebase/repositories/users';
import { findUniversityByCode } from '@/lib/firebase/repositories/reference';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { completeProfileSchema, splitFullName } from '@/server/validators/auth';
import { hashEmail, hashPassword } from '@/lib/crypto/hash';
import { isRecentSignIn } from '@/lib/auth/reauth';
import { isPlaceholderEmail } from '@/lib/auth/username';
import { sendVerificationEmail } from '@/lib/auth/email-verification';
import { sendEmailAsync } from '@/lib/email/send';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/me/onboarding - finish a quick-login account.
 *
 * A first Google sign-in creates an account at once, with
 * a temporary "user34232" handle and `profileIncomplete: true`, which keeps it
 * view-only (see permissions.can). This is the one way out of that state: name,
 * nickname, university and a local PASSWORD - plus an email when the provider
 * gave none. The password is what keeps the account reachable if the Google
 * account is ever lost, so the profile cannot be finished without it.
 *
 * Refused (409) once the profile is complete, so it can never become a second,
 * unaudited way to rename an existing account.
 */
export async function POST(request: NextRequest) {
  let userId: string;
  let authenticatedAt: Date;
  try {
    ({ userId, authenticatedAt } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const rate = await rateLimit('profile:complete', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const parsed = completeProfileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // A password is a new way in; a stale or borrowed session may not add one.
  if (!isRecentSignIn(authenticatedAt)) {
    return NextResponse.json({ error: 'auth.setPassword.errors.signInAgain' }, { status: 403 });
  }

  const user = await findUserById(userId);
  if (!user) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  if (user.profileIncomplete !== true) {
    return NextResponse.json({ error: 'onboarding.errors.alreadyComplete' }, { status: 409 });
  }

  // An email is asked for only when the provider supplied none; otherwise the
  // provider's address stands and anything sent is ignored.
  const needsEmail = isPlaceholderEmail(user.email);
  if (needsEmail && !input.email) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: { email: ['errors.fieldRequired'] } },
      { status: 400 },
    );
  }

  const university = await findUniversityByCode(input.universityId);
  if (!university) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: { universityId: ['errors.fieldRequired'] } },
      { status: 400 },
    );
  }

  const { firstName, lastName } = splitFullName(input.fullName);
  const result = await completeProfile(userId, {
    fullName: input.fullName,
    firstName,
    lastName,
    nickname: input.nickname,
    universityId: university.id,
    passwordHash: await hashPassword(input.password),
    email: needsEmail && input.email ? { value: input.email, hash: hashEmail(input.email) } : undefined,
  });

  if (result === 'already_complete') {
    return NextResponse.json({ error: 'onboarding.errors.alreadyComplete' }, { status: 409 });
  }
  if (result === 'nickname') {
    return NextResponse.json(
      {
        error: 'auth.errors.nicknameTaken',
        field: 'nickname',
        fields: { nickname: ['auth.errors.nicknameTaken'] },
      },
      { status: 409 },
    );
  }
  if (result !== 'ok') {
    /**
     * The email is named, matching registration. There is no phone on this
     * form, so there is nothing to collapse it with - the shared
     * "these details cannot be used" string said strictly less than
     * "this email is already in use" while pointing at the same single field.
     * AUTH_COLLAPSE_SIGNUP_CONFLICTS restores it for deployments that prefer
     * the vaguer message; see the register route for the trade-off.
     */
    const message =
      process.env.AUTH_COLLAPSE_SIGNUP_CONFLICTS === 'true'
        ? 'auth.errors.credentialsUnavailable'
        : 'auth.errors.emailTaken';
    return NextResponse.json(
      { error: message, field: 'email', fields: { email: [message] } },
      { status: 409 },
    );
  }

  await writeAuditLog({
    actorId: userId,
    action: 'PROFILE_COMPLETED',
    entityType: 'user',
    entityId: userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    after: { nickname: input.nickname, emailProvided: needsEmail },
  });

  const email = needsEmail && input.email ? input.email : user.email;
  sendEmailAsync(
    email,
    'welcome',
    { nickname: input.nickname, university: university.nameEn, faculty: null },
    { dedupeKey: `welcome:${userId}` },
  );
  if (!user.emailVerifiedAt || needsEmail) {
    await sendVerificationEmail({ id: userId, email, nickname: input.nickname }).catch(() => {});
  }

  return NextResponse.json({ ok: true, nickname: input.nickname });
}
