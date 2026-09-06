import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus, Prisma, UserRole } from '@prisma/client';
import { db } from '@/lib/db';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { clientIp } from '@/lib/security/ratelimit';
import type { Viewer } from '@/lib/permissions';

/**
 * Authorization for the admin panel.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A COPIED `if` IN EVERY ROUTE
 * ---------------------------------------------------------------------------
 * The two admin endpoints that existed before this panel each carried their own
 * `viewer.role !== MODERATOR && viewer.role !== ADMIN` check. That works while
 * there are two of them; at twenty it becomes the classic failure where one
 * handler is added without the check and nobody notices, because the UI never
 * links to it. Every admin route now calls `requireAdmin`, so "is this endpoint
 * protected" is answerable by grep rather than by reading each file.
 *
 * ---------------------------------------------------------------------------
 * TWO TIERS, BUILT FROM THE EXISTING ENUM
 * ---------------------------------------------------------------------------
 * `UserRole` has no SUPERADMIN member and this module does not add one - a new
 * enum value is a migration plus a data backfill, and the existing enum already
 * expresses the distinction that matters:
 *
 *   MODERATOR - read the panel, work the verification queue. This is the role
 *               the pre-existing review endpoints already accepted, so their
 *               behaviour is unchanged.
 *   ADMIN     - everything above, plus the actions that are irreversible or
 *               that change who else holds power: role changes, account status
 *               changes, session revocation, deletion, university writes.
 *
 * ADMIN is therefore the "superadmin" tier. If a third tier is ever genuinely
 * needed, add it to UserRole and to ROLE_RANK below - nothing else reads the
 * ordering.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROLE IS READ FROM THE DATABASE, NEVER FROM THE TOKEN
 * ---------------------------------------------------------------------------
 * `requireSession` already loads live account state on every call, and the
 * access token deliberately carries no role claim (see the comment on
 * issueSession). A moderator demoted thirty seconds ago must lose the panel
 * immediately, not when their 15-minute token expires. Everything here builds
 * on that guarantee rather than trusting the JWT.
 */

const ROLE_RANK: Record<string, number> = {
  [UserRole.MODERATOR]: 1,
  [UserRole.ADMIN]: 2,
};

export type AdminTier = 'MODERATOR' | 'ADMIN';

export class ForbiddenError extends Error {
  readonly status = 403;
  readonly messageKey = 'errors.forbidden';
}

export type AdminActor = {
  id: string;
  viewer: Viewer;
  /** True when the actor may take the irreversible / power-granting actions. */
  isAdmin: boolean;
};

/**
 * Asserts the caller holds at least `minTier`. Throws, so a handler that
 * forgets to check the result still fails closed.
 */
export async function requireAdmin(
  request: NextRequest,
  minTier: AdminTier = 'MODERATOR',
): Promise<AdminActor> {
  const { userId, viewer } = await requireSession(request);

  /**
   * A frozen or restricted staff account may not administer.
   *
   * Freezing a colleague is one of the actions this panel exists to perform,
   * so "frozen admin keeps full admin powers" would make the control
   * meaningless against exactly the insider case it is most needed for.
   * Checked before the rank test so the reason is the accurate one.
   */
  if (
    viewer.accountStatus === AccountStatus.SUSPENDED ||
    viewer.accountStatus === AccountStatus.RESTRICTED
  ) {
    throw new ForbiddenError();
  }

  const rank = ROLE_RANK[viewer.role] ?? 0;
  if (rank < (ROLE_RANK[minTier] ?? Number.MAX_SAFE_INTEGER)) {
    throw new ForbiddenError();
  }

  return { id: userId, viewer, isAdmin: viewer.role === UserRole.ADMIN };
}

/**
 * Wraps a handler so authorization failures become status codes instead of
 * unhandled throws (which Next renders as a 500 with a stack trace).
 *
 * 401 and 403 are answered distinctly: 401 means "sign in", 403 means "signed
 * in, not allowed". Collapsing them would leave a demoted moderator stuck in a
 * login loop. Neither response says whether the requested record exists.
 */
export async function withAdmin<T>(
  request: NextRequest,
  minTier: AdminTier,
  handler: (actor: AdminActor) => Promise<T>,
): Promise<T | NextResponse> {
  let actor: AdminActor;
  try {
    actor = await requireAdmin(request, minTier);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
    }
    throw error;
  }

  try {
    return await handler(actor);
  } catch (error) {
    // A Prisma error message can quote column values, so it is logged rather
    // than returned. The client gets a code it can translate and nothing else.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error(`[admin] prisma ${error.code} on ${request.nextUrl.pathname}`);
      return NextResponse.json({ error: 'errors.generic' }, { status: 400 });
    }
    console.error(`[admin] unhandled error on ${request.nextUrl.pathname}`, error);
    return NextResponse.json({ error: 'errors.generic' }, { status: 500 });
  }
}

/**
 * Writes an admin action to the existing audit log.
 *
 * Deliberately takes the same shape as the AuditLog model rather than
 * inventing a wrapper type, so a reader can match a row in the table to a call
 * site without a translation step. `before`/`after` must contain only the
 * fields that actually changed - never a whole user record, which would copy
 * emails and phone numbers into a second table that outlives account deletion.
 *
 * Pass `tx` when the action is part of a transaction so the audit row commits
 * or rolls back with the change it describes.
 */
export type AuditResult = 'SUCCESS' | 'FAILURE' | 'DENIED';

/**
 * The client address, for the audit row only.
 *
 * Read the note on AuditLog.ip in schema.prisma before reusing this anywhere
 * else. The platform's "no IP banning" rule is intact and this does not bend
 * it: that rule is about SANCTIONING a shared student address, whereas this
 * records where a staff member was when they exercised power over someone
 * else's account. Nothing may join this value to the blocklist.
 *
 * Reuses clientIp() rather than re-parsing the proxy headers, so there is one
 * definition of "which header do we trust" in the codebase.
 */
function auditIp(request?: NextRequest): string | undefined {
  if (!request) return undefined;
  const ip = clientIp(request.headers);
  // clientIp falls back to a placeholder for unknown addresses; storing that
  // would be worse than storing nothing, because it looks like a real value.
  if (!ip || ip === 'unknown' || ip === '0.0.0.0') return undefined;
  return ip.slice(0, 45);
}

export async function adminAudit(params: {
  tx?: Prisma.TransactionClient;
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /**
   * Outcome of the action. Defaults to SUCCESS because the overwhelming
   * majority of call sites write their row after the change committed - a
   * denial or a failure is the case worth stating explicitly.
   */
  result?: AuditResult;
  request?: NextRequest;
}): Promise<void> {
  const client = params.tx ?? db;
  await client.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before,
      after: params.after,
      result: params.result ?? 'SUCCESS',
      ip: auditIp(params.request),
      userAgent: params.request?.headers.get('user-agent')?.slice(0, 512),
    },
  });
}

/**
 * Server-component guard for /admin pages.
 *
 * The middleware only proves "signed in" - it runs at the edge with no database
 * access. This is what proves "and is staff", and it runs before any admin page
 * renders. It returns null instead of throwing so the layout can redirect.
 */
export async function getAdminViewer(): Promise<Viewer | null> {
  try {
    const { viewer } = await requireSession();
    if ((ROLE_RANK[viewer.role] ?? 0) === 0) return null;
    // Mirrors requireAdmin: a frozen staff account loses the panel, not just
    // the API. Otherwise the shell would render for someone every endpoint
    // behind it refuses, which reads as a broken panel rather than a decision.
    if (
      viewer.accountStatus === AccountStatus.SUSPENDED ||
      viewer.accountStatus === AccountStatus.RESTRICTED
    ) {
      return null;
    }
    return viewer;
  } catch {
    return null;
  }
}
