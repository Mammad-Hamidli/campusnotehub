import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdmin } from '@/lib/auth/admin';
import {
  approveMentorApplication,
  findMentorApplication,
  rejectMentorApplication,
} from '@/lib/firebase/repositories/mentorApplications';
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

/** PATCH /api/admin/mentor-applications/:userId  { decision, reason? } */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const { userId } = await params;
    const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const application = await findMentorApplication(userId);
    if (!application) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    if (application.status !== 'PENDING') {
      return NextResponse.json({ error: 'admin.reviews.errors.alreadyDecided' }, { status: 409 });
    }

    const applicant = await findUserById(userId);
    const { decision, reason } = parsed.data;

    let profileId: string | null = null;
    if (decision === 'APPROVE') {
      profileId = await approveMentorApplication(application, actor.id);
    } else {
      await rejectMentorApplication(userId, actor.id, reason!);
    }

    await writeModerationAction({
      moderatorId: actor.id,
      targetType: 'mentor_application',
      targetId: userId,
      action: decision === 'APPROVE' ? 'approve' : 'reject',
      reason: reason ?? 'Mentor application approved',
    });
    await writeAuditLog({
      actorId: actor.id,
      action: decision === 'APPROVE' ? 'MENTOR_APPLICATION_APPROVED' : 'MENTOR_APPLICATION_REJECTED',
      entityType: 'mentor_application',
      entityId: userId,
      after: { profileId, reason: reason ?? null },
    });

    await enqueueNotification({
      userId,
      type: 'SYSTEM',
      titleKey:
        decision === 'APPROVE'
          ? 'notifications.mentor.approvedTitle'
          : 'notifications.mentor.rejectedTitle',
      bodyKey:
        decision === 'APPROVE'
          ? 'notifications.mentor.approvedBody'
          : 'notifications.mentor.rejectedBody',
      linkUrl: decision === 'APPROVE' && profileId ? `/mentors/${profileId}` : '/mentors/apply',
      // The dedicated email below carries this event; no generic duplicate.
      skipEmail: true,
    });

    if (applicant) {
      if (decision === 'APPROVE') {
        sendEmailAsync(applicant.email, 'mentorApplicationApproved', {
          nickname: applicant.nickname,
          profileUrl: profileId ? `/mentors/${profileId}` : '/mentors',
        });
      } else {
        sendEmailAsync(applicant.email, 'mentorApplicationRejected', {
          nickname: applicant.nickname,
          reason: reason ?? null,
        });
      }
    }

    return NextResponse.json({ ok: true, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', profileId });
  });
}
