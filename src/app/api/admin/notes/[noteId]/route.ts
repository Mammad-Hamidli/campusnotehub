import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NoteStatus } from '@/lib/enums';
import { withAdmin } from '@/lib/auth/admin';
import { findNoteById, updateNote } from '@/lib/firebase/repositories/notes';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { writeModerationAction } from '@/lib/firebase/repositories/moderation';
import { enqueueNotification } from '@/lib/notifications/dispatch';
import { sendEmailAsync } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const decisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((d) => d.decision === 'APPROVE' || (d.reason?.length ?? 0) >= 5, {
    path: ['reason'],
    message: 'admin.reviews.errors.reasonRequired',
  });

/**
 * PATCH /api/admin/notes/:noteId  { decision, reason? }
 *
 * APPROVE publishes the note (it appears in the UniNotes listing); REJECT
 * records the reason the seller is shown.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ noteId: string }> },
) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const { noteId } = await params;
    const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const note = await findNoteById(noteId);
    if (!note) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    if (note.status !== NoteStatus.PENDING_REVIEW && note.status !== NoteStatus.DRAFT) {
      return NextResponse.json({ error: 'admin.reviews.errors.alreadyDecided' }, { status: 409 });
    }

    const { decision, reason } = parsed.data;
    const now = new Date();

    if (decision === 'APPROVE') {
      await updateNote(noteId, { status: NoteStatus.PUBLISHED, publishedAt: now, rejectionReason: null });
    } else {
      await updateNote(noteId, { status: NoteStatus.REJECTED, rejectionReason: reason });
    }

    await writeModerationAction({
      moderatorId: actor.id,
      targetType: 'note',
      targetId: noteId,
      action: decision === 'APPROVE' ? 'approve' : 'reject',
      reason: reason ?? 'Note approved',
    });
    await writeAuditLog({
      actorId: actor.id,
      action: decision === 'APPROVE' ? 'NOTE_APPROVED' : 'NOTE_REJECTED',
      entityType: 'note',
      entityId: noteId,
      before: { status: note.status },
      after: { status: decision === 'APPROVE' ? NoteStatus.PUBLISHED : NoteStatus.REJECTED, reason: reason ?? null },
    });

    await enqueueNotification({
      userId: note.sellerId,
      type: 'NOTE_MODERATION',
      titleKey: decision === 'APPROVE' ? 'notifications.note.approvedTitle' : 'notifications.note.rejectedTitle',
      bodyKey: decision === 'APPROVE' ? 'notifications.note.approvedBody' : 'notifications.note.rejectedBody',
      params: { title: note.title },
      linkUrl: '/notes',
      skipEmail: true,
    });

    const seller = await findUserById(note.sellerId);
    if (seller) {
      if (decision === 'APPROVE') {
        sendEmailAsync(seller.email, 'noteApproved', { nickname: seller.nickname, title: note.title });
      } else {
        sendEmailAsync(seller.email, 'noteRejected', {
          nickname: seller.nickname,
          title: note.title,
          reason: reason ?? null,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      status: decision === 'APPROVE' ? NoteStatus.PUBLISHED : NoteStatus.REJECTED,
    });
  });
}
