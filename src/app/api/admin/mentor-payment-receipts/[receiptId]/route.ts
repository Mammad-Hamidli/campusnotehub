import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdmin } from '@/lib/auth/admin';
import { decideMentorPaymentReceipt } from '@/lib/firebase/repositories/mentorPayments';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sendEmailAsync } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ decision: z.enum(['APPROVED', 'INVALID']) }).strict();

/**
 * PATCH /api/admin/mentor-payment-receipts/:receiptId { decision: APPROVED | INVALID }
 *
 * APPROVED also activates a mentor account still waiting for its first
 * payment (see decideMentorPaymentReceipt); `activated` says whether it did.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ receiptId: string }> }) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    const { receiptId } = await params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(receiptId)) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    let receipt;
    try {
      receipt = await decideMentorPaymentReceipt(receiptId, parsed.data.decision, actor.id);
    } catch (error) {
      if (error instanceof Error && error.message === 'ALREADY_DECIDED') {
        return NextResponse.json({ error: 'mentors.payment.alreadyDecided' }, { status: 409 });
      }
      throw error;
    }
    if (!receipt) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

    await writeAuditLog({
      actorId: actor.id,
      action: parsed.data.decision === 'APPROVED' ? 'MENTOR_PAYMENT_APPROVED' : 'MENTOR_PAYMENT_INVALID',
      entityType: 'mentor_payment_receipt',
      entityId: receipt.id,
      after: { userId: receipt.userId, activated: receipt.activated },
    });

    const user = await findUserById(receipt.userId);
    if (user && !user.deletedAt) {
      sendEmailAsync(
        user.email,
        parsed.data.decision === 'APPROVED' ? 'mentorPaymentApproved' : 'mentorPaymentInvalid',
        { nickname: user.nickname },
        { dedupeKey: `mentor-payment-decision:${receipt.id}:${parsed.data.decision}` },
      );
    }
    return NextResponse.json({ receiptId, status: parsed.data.decision, activated: receipt.activated });
  });
}
