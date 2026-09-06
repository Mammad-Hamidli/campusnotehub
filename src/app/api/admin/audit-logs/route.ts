import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { withAdmin } from '@/lib/auth/admin';
import { adminAuditListSchema } from '@/server/validators/admin';
import { auditWhere } from '@/lib/admin/auditQuery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/audit-logs - read-only, deliberately.
 *
 * There is no POST, PATCH or DELETE in this file and there must never be one.
 * The `campushub_app` role holds only INSERT and SELECT on audit_logs
 * (0001_invariants.sql revokes UPDATE and DELETE), so an edit endpoint would
 * fail at the database anyway - but the absence here is what makes the
 * guarantee legible to a reader, and stops someone "fixing" the permission
 * error by granting the missing privilege.
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

    const [total, rows] = await db.$transaction([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          before: true,
          after: true,
          userAgent: true,
          ip: true,
          result: true,
          createdAt: true,
          actor: { select: { id: true, nickname: true, role: true } },
        },
      }),
    ]);

    return NextResponse.json(
      {
        logs: rows,
        page: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
