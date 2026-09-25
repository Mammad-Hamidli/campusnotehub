import { NextResponse, type NextRequest } from 'next/server';
import { listAuditLogs } from '@/lib/firebase/repositories/audit';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { withAdmin } from '@/lib/auth/admin';
import { adminAuditListSchema } from '@/server/validators/admin';
import { auditWhere } from '@/lib/admin/auditQuery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/audit-logs - read-only, deliberately.
 *
 * There is no POST, PATCH or DELETE in this file and there must never be one.
 * Under Postgres the `campusnotehub_app` role held only INSERT and SELECT on
 * audit_logs, so an edit endpoint would have failed at the database. Firestore
 * has no per-collection role grants for a service account - the Admin SDK
 * bypasses every rule - so that backstop is GONE, and the absence of a writer
 * here is now the whole of the guarantee rather than a legible restatement of
 * one. See the header of the audit repository for what else is available.
 *
 * ---------------------------------------------------------------------------
 * ON IP ADDRESSES - THIS CHANGED, READ THE DISTINCTION
 * ---------------------------------------------------------------------------
 * This endpoint now returns `ip`, and that is NOT a reversal of the platform's
 * position on network identifiers. Two different things were being conflated:
 *
 *   BANNING an address is still refused, permanently and structurally.
 *   BlocklistType has no IP member, and 0002_zero_retention.sql has a CHECK
 *   constraint that rejects one. Campus NAT and carrier CGNAT put thousands of
 *   students behind a single address, so a block there is collective
 *   punishment. Nothing here weakens that.
 *
 *   RECORDING the address a STAFF member acted from is the opposite case: an
 *   accountability trail about a small, named set of operators exercising
 *   power over other people's accounts. "Which admin deleted this account, and
 *   from where" is the question an audit log exists to answer, and answering
 *   it with only a user-agent string is answering it badly.
 *
 * So `ip` is written by adminAudit() for admin actions and is null on
 * everything else, including ordinary user traffic. The `deviceFingerprint`
 * remains a ban anchor rather than an identifier and is still NOT returned in
 * bulk here.
 *
 * ---------------------------------------------------------------------------
 * ON MAC ADDRESSES
 * ---------------------------------------------------------------------------
 * There is no MAC column and there will not be one. A browser cannot read the
 * client's MAC address - it is a link-layer identifier that never leaves the
 * local network segment, and no web API exposes it. Any field claiming to hold
 * one would be either empty or fabricated, and a fabricated field in an audit
 * log is worse than a missing one. IP plus user-agent plus the existing device
 * fingerprint is the honest ceiling for what a web client can attest to.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const parsed = adminAuditListSchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const input = parsed.data;
    const where = auditWhere(input);

    /**
     * ONE read, then page in memory - not a count plus an offset query.
     *
     * The SQL version paired `count()` with `skip`/`take` inside a transaction
     * so the total and the page agreed. Firestore has neither `skip` nor a
     * count that respects the in-memory half of this filter, and a separate
     * count() aggregation would disagree with the page whenever the free-text
     * match narrowed it.
     *
     * So the filtered set is materialised once under the repository's scan
     * ceiling and sliced here. The total is therefore the total of what
     * matched, which is what the pager needs, and `truncated` says when the
     * ceiling was reached so a partial view is never read as a complete one.
     */
    const { rows: matched, truncated } = await listAuditLogs(where, 5000);

    const total = matched.length;
    const rows = matched.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);

    // The actor decoration Prisma did with a join, as one batched read over
    // the page only - never over the whole filtered set.
    const actors = await findUsersByIds(
      rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)),
    );

    return NextResponse.json(
      {
        logs: rows.map((r) => {
          const actor = r.actorId ? actors.get(r.actorId) : null;
          return {
            id: r.id,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            before: r.before,
            after: r.after,
            userAgent: r.userAgent,
            ip: r.ip,
            result: r.result,
            createdAt: r.createdAt,
            actor: actor ? { id: actor.id, nickname: actor.nickname, role: actor.role } : null,
          };
        }),
        page: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
          truncated,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
