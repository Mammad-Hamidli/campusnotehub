import { NextResponse, type NextRequest } from 'next/server';
import { withAdmin } from '@/lib/auth/admin';
import { listMentorPaymentReceipts, type MentorPaymentStatus } from '@/lib/firebase/repositories/mentorPayments';
import { findUsersByIds } from '@/lib/firebase/repositories/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: readonly MentorPaymentStatus[] = ['PENDING', 'APPROVED', 'INVALID'];

/**
 * GET /api/admin/mentor-payment-receipts?status=PENDING
 *
 * The receipt queue, oldest first, with the account each receipt belongs to -
 * enough for a moderator to match a transfer against the expected fee without
 * opening the user record.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const requested = request.nextUrl.searchParams.get('status') ?? 'PENDING';
    if (!STATUSES.includes(requested as MentorPaymentStatus)) {
      return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    }
    const receipts = await listMentorPaymentReceipts(requested as MentorPaymentStatus);
    const users = await findUsersByIds(receipts.map((r) => r.userId));
    return NextResponse.json({
      receipts: receipts.map((r) => {
        const user = users.get(r.userId);
        return {
          ...r,
          user: user && !user.deletedAt
            ? {
                id: user.id,
                nickname: user.nickname,
                fullName: user.fullName,
                email: user.email,
                mentorType: user.mentorType ?? null,
                mentorRegistrationStatus: user.mentorRegistrationStatus ?? null,
              }
            : null,
        };
      }),
    }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
