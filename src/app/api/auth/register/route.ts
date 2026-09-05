import { NextResponse, type NextRequest } from 'next/server';
import { VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { registerSchema } from '@/server/validators/auth';
import { hashPassword, hashEmail, hashPhone } from '@/lib/crypto/hash';
import { checkSignupBlocked, recordDevice } from '@/lib/security/blocklist';
import { deviceLabel } from '@/lib/security/fingerprint';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { issueSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

/**
 * Field names that must never appear in a query string. Both our canonical
 * schema keys and the HTML name=/autocomplete= tokens the browser would emit
 * on a native GET submit ('new-password', 'tel', 'username'), since the whole
 * point is to catch the submission shape we do NOT control.
 */
const CREDENTIAL_QUERY_KEYS = new Set([
  'password', 'passwordconfirm', 'new-password', 'current-password',
  'email', 'phone', 'tel', 'nickname', 'username', 'fullname', 'name',
]);

/**
 * Registration is POST-only, and the 405 is explicit rather than implied.
 *
 * Next.js already answers 405 for an unexported method, but stating it here
 * makes the constraint reviewable in this file and guarantees the endpoint can
 * never be reached by a shape - a link, a redirect, a prefetch, an <img src> -
 * that would put credentials in a URL. Cache-Control stops any intermediary
 * from retaining the response to such an attempt.
 */
export async function GET() {
  return NextResponse.json(
    { error: 'errors.methodNotAllowed' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}

export const HEAD = GET;

/**
 * POST /api/auth/register  -  Step 1 of the funnel.
 *
 * Creates the account and signs the user in immediately with
 * verificationStatus = UNVERIFIED. Document upload is a separate step so a
 * dropped connection during a 12 MB upload does not lose the account, and so
 * the user is never staring at a spinner while a model runs.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);

  const limit = await rateLimit('auth:register', { ip });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  /**
   * The body is the ONLY accepted channel for credentials.
   *
   * If this request arrived carrying registration fields in its query string,
   * something upstream has already leaked them - into history, access logs and
   * the Referer header - before we ever saw it. We refuse rather than quietly
   * succeeding, because a 201 here would teach a client that the unsafe shape
   * works and let the leak harden into a supported path. We deliberately do
   * not echo the offending key back: it would copy the secret into our own
   * error logs, which is the exact thing being prevented.
   */
  const leakedParams = [...request.nextUrl.searchParams.keys()].filter((key) =>
    CREDENTIAL_QUERY_KEYS.has(key.toLowerCase()),
  );
  if (leakedParams.length > 0) {
    return NextResponse.json(
      { error: 'errors.credentialsInQueryString' },
      { status: 400 },
    );
  }

  // Reject urlencoded/multipart submissions outright. A native browser form
  // POST would arrive as application/x-www-form-urlencoded; accepting it would
  // mean supporting a path whose GET twin is the vulnerability we just closed.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return NextResponse.json({ error: 'errors.unsupportedMediaType' }, { status: 415 });
  }

  // A malformed body must be a 400, not an unhandled throw that becomes a 500
  // and a stack trace in the logs.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Blocklist check before any write. A banned identity gets the same generic
  // response as a duplicate email - telling someone *which* rule caught them
  // is free tuning information.
  const blocked = await checkSignupBlocked({
    email: input.email,
    phone: input.phone,
    deviceFingerprint: input.deviceFingerprint,
  });
  if (blocked.blocked) {
    return NextResponse.json({ error: 'verification.failure.generic' }, { status: 403 });
  }

  const university = await db.university.findFirst({
    where: { id: input.universityId, isActive: true },
    select: { id: true, emailDomains: true },
  });
  if (!university) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          emailHash: hashEmail(input.email),
          passwordHash,
          fullName: input.fullName,
          nickname: input.nickname,
          locale: input.locale,
          universityId: university.id,
          facultyId: input.facultyId,
          graduationYear: input.graduationYear,
          graduationMonth: input.graduationMonth,
          verificationStatus: VerificationStatus.UNVERIFIED,
          phone: input.phone,
          phoneHash: input.phone ? hashPhone(input.phone) : null,
        },
        select: { id: true, email: true, role: true, locale: true, verificationStatus: true, accountStatus: true },
      });

      // Wallet exists from minute one so a purchase never has to create it
      // inside a money-moving transaction.
      await tx.wallet.create({ data: { userId: created.id } });

      await tx.auditLog.create({
        data: {
          actorId: created.id,
          action: 'USER_REGISTERED',
          entityType: 'user',
          entityId: created.id,
          deviceFingerprint: input.deviceFingerprint,
          userAgent: request.headers.get('user-agent')?.slice(0, 512),
        },
      });

      return created;
    });

    // Record the device before the session so the session can reference it.
    // This is the replacement for logging a signup IP: it is what a later ban
    // attaches to, and unlike an address it does not implicate a whole dorm.
    const deviceId = input.deviceFingerprint
      ? await recordDevice({
          userId: user.id,
          fingerprint: input.deviceFingerprint,
          label: deviceLabel(request.headers.get('user-agent') ?? undefined),
        })
      : undefined;

    const session = await issueSession({
      user,
      userAgent: request.headers.get('user-agent') ?? '',
      deviceId,
    });

    // 201 with the next step spelled out, so the client does not have to
    // hard-code the funnel order.
    const response = NextResponse.json(
      {
        user: { id: user.id, verificationStatus: user.verificationStatus },
        next: { step: 'VERIFY_DOCUMENTS', href: '/verify' },
      },
      { status: 201 },
    );
    session.applyCookies(response);
    return response;
  } catch (error) {
    /**
     * Unique violation. Which field clashed determines what we may say.
     *
     * NICKNAME -> named explicitly. A nickname is public by design: it renders
     * in the feed, on note listings and in mentor reviews, so "that handle is
     * taken" leaks nothing you could not learn by scrolling. And the user
     * cannot pick a different one unless we tell them.
     *
     * EMAIL or PHONE -> collapsed into ONE shared message. Distinguishing them
     * turns signup into a two-field enumeration oracle: an attacker learns
     * both which addresses AND which phone numbers already have accounts here.
     * Phone is the more sensitive of the two, because SIM registration in
     * Azerbaijan is identity-linked.
     *
     * HONEST LIMITATION: this halves the oracle's precision but does not
     * remove it - the caller still learns that *one of* the two is in use.
     * Fully closing it needs the deferred-verification flow: always answer
     * 201, create nothing, and email the address either a verification link
     * (new) or a "someone tried to sign up as you" notice (existing). That
     * needs working mail delivery, so it is deliberately not done here.
     */
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      const target = String(
        (error as { meta?: { target?: string[] | string } }).meta?.target ?? '',
      );
      const key = target.includes('nickname')
        ? 'auth.errors.nicknameTaken'
        : 'auth.errors.credentialsUnavailable';
      return NextResponse.json({ error: key }, { status: 409 });
    }
    throw error;
  }
}
