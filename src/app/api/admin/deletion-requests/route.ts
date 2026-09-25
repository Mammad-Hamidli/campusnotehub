import { NextResponse, type NextRequest } from 'next/server';
import { withAdmin } from '@/lib/auth/admin';
import {
  listDeletionRequests,
  type DeletionRequestStatus,
} from '@/lib/firebase/repositories/deletionRequests';
import { findUsersByIds } from '@/lib/firebase/repositories/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: DeletionRequestStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

/**
 * GET /api/admin/deletion-requests?status=PENDING
 *
 * ADMIN tier, not MODERATOR: approving one deletes an account, which is an
 * ADMIN-only action everywhere else in the panel (DELETE /api/admin/users).
 *
 * Each row carries what the reviewer needs to decide without opening three
 * other screens.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'ADMIN', async () => {
    const requested = request.nextUrl.searchParams.get('status') as DeletionRequestStatus | null;
    const status = requested && STATUSES.includes(requested) ? requested : 'PENDING';

    const rows = await listDeletionRequests(status);
    const users = await findUsersByIds(rows.map((r) => r.userId));

    return NextResponse.json(
      {
        requests: rows.map((r) => {
          const user = users.get(r.userId);
          return {
            userId: r.userId,
            status: r.status,
            reason: r.reason,
            requestedAt: r.requestedAt,
            decidedAt: r.decidedAt,
            decisionNote: r.decisionNote,
            user: user
              ? {
                  nickname: user.nickname,
                  fullName: user.fullName,
                  email: user.email,
                  role: user.role,
                  accountStatus: user.accountStatus,
                  createdAt: user.createdAt,
                  deleted: Boolean(user.deletedAt),
                }
              : null,
          };
        }),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
