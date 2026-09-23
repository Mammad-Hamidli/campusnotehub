import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NotificationType, UserRole } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { reauthenticate, reauthRequirement } from '@/lib/auth/reauth';
import { findUserById, listUsers } from '@/lib/firebase/repositories/users';
import {
  DeletionRequestError,
  closeDeletionRequest,
  createDeletionRequest,
  findDeletionRequest,
  type DeletionRequestRecord,
} from '@/lib/firebase/repositories/deletionRequests';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { enqueueNotification } from '@/lib/notifications/dispatch';
import { sendEmailAsync } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/me/deletion-request - the signed-in user's own account deletion request.
 *
 *   GET     the current request, or null
 *   POST    file one: { password, reason? }
 *   DELETE  cancel a PENDING one
 *
 * Filing does NOT delete anything. It queues the request for an administrator
 * (/admin/reviews -> Deletion requests), who approves it - running the same
 * soft delete as the admin panel - or rejects it with a reason. See
 * src/lib/firebase/repositories/deletionRequests.ts for why this is manual.
 */

async function session(request: NextRequest) {
  try {
    return await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/** The client's view of a request. decidedById stays server-side. */
function present(r: DeletionRequestRecord | null) {
  return r
    ? { status: r.status, requestedAt: r.requestedAt, decidedAt: r.decidedAt, decisionNote: r.decisionNote }
    : null;
}

export async function GET(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

  return NextResponse.json(
    {
      request: present(await findDeletionRequest(auth.userId)),
      // Which proof the form should ask for. The account's own owner already
      // knows whether they have a password or 2FA, so this discloses nothing.
      reauth: await reauthRequirement(auth.userId),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * The proof matches what the account has - see lib/auth/reauth.ts: an
 * authenticator code when 2FA is on, else the password, else (an account
 * created through Google, which has no password) a sign-in
 * within the last ten minutes.
 */
const createSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  code: z.string().trim().max(16).optional(),
  recoveryCode: z.string().trim().max(32).optional(),
  reason: z.string().trim().max(1000).optional().nullable(),
});

export async function POST(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  const { userId } = auth;

  // Before the password check: this endpoint verifies a password, so it must
  // not become an unmetered guessing oracle for a stolen session.
  const limit = await rateLimit('account:deletion', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  /**
   * Re-authentication. A session cookie proves a browser is signed in, not
   * that the account owner is at it: a borrowed laptop or a stolen cookie
   * must not be enough to set an account on the path to deletion.
   */
  const user = await findUserById(userId);
  if (!user) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  const proof = await reauthenticate(request, auth, parsed.data);
  if (proof instanceof Response) {
    // Keep the long-standing message for the password case the form shows inline.
    const body = await proof.clone().json().catch(() => ({}));
    if (body.error === 'auth.errors.reauthFailed') {
      return NextResponse.json({ error: 'settings.deletion.errors.wrongPassword' }, { status: 403 });
    }
    return proof;
  }

  let created: DeletionRequestRecord;
  try {
    created = await createDeletionRequest(userId, parsed.data.reason || null);
  } catch (error) {
    if (error instanceof DeletionRequestError) {
      return NextResponse.json({ error: error.messageKey }, { status: error.status });
    }
    throw error;
  }

  await writeAuditLog({
    actorId: userId,
    action: 'ACCOUNT_DELETION_REQUESTED',
    entityType: 'user',
    entityId: userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
  });

  /**
   * Put it in front of the administrators: an in-app notification each, which
   * also reaches them by email (see emailNotification in dispatch.ts), linking
   * straight to the queue. Settled rather than awaited one by one, so one
   * failed notification cannot fail the user's request after it was filed.
   */
  const { users: admins } = await listUsers({ role: UserRole.ADMIN }, 1, 50, 'createdAt', 'asc');
  await Promise.allSettled(
    admins.map((admin) =>
      enqueueNotification({
        userId: admin.id,
        type: NotificationType.SYSTEM,
        titleKey: 'notifications.deletionRequest.title',
        bodyKey: 'notifications.deletionRequest.body',
        params: { nickname: user.nickname },
        linkUrl: '/admin/reviews?tab=deletions',
      }),
    ),
  );

  sendEmailAsync(user.email, 'accountDeletionRequested', { nickname: user.nickname });

  return NextResponse.json({ request: present(created) }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

  try {
    await closeDeletionRequest(auth.userId, 'CANCELLED', auth.userId, null);
  } catch (error) {
    if (error instanceof DeletionRequestError) {
      return NextResponse.json({ error: error.messageKey }, { status: error.status });
    }
    throw error;
  }

  await writeAuditLog({
    actorId: auth.userId,
    action: 'ACCOUNT_DELETION_CANCELLED',
    entityType: 'user',
    entityId: auth.userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
  });

  return NextResponse.json({ request: present(await findDeletionRequest(auth.userId)) });
}
