import { NextResponse, type NextRequest } from 'next/server';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { countAiQueuedCases } from '@/lib/firebase/repositories/verification';
import { aiBatchStatus } from '@/lib/verification/aiQueue';
import { scheduleAiBatch } from '@/lib/verification/aiBatchTrigger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST runs a batch in after(); see the cron route for the same ceiling.
export const maxDuration = 300;

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/admin/verification/ai-batch - the AI check's state for the panel:
 * queue length, whether a run holds the lease, and the last run's tally.
 * Moderators may look; `canRun` tells the client whether to offer the button.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const [status, queued] = await Promise.all([aiBatchStatus(), countAiQueuedCases()]);
    return NextResponse.json({ ...status, queued, canRun: actor.isAdmin }, { headers: NO_STORE });
  });
}

/**
 * POST /api/admin/verification/ai-batch - "Run now". ADMIN only.
 *
 * Starts exactly what the nightly cron starts (scheduleAiBatch: a time-boxed
 * run that hands over to the cron route until the queue is drained or Workers
 * AI stops it) and answers 202 at once. The nightly schedule is untouched.
 *
 * A run already holding the lease answers 409 rather than queueing a second
 * one; were two requests to race past this check, the batch's own lease still
 * lets only one of them work. An empty queue answers 409 too, so a click never
 * spends a function invocation on nothing.
 */
export async function POST(request: NextRequest) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const [status, queued] = await Promise.all([aiBatchStatus(), countAiQueuedCases()]);
    const refusal = status.running
      ? 'admin.verifications.ai.errors.running'
      : queued === 0
        ? 'admin.verifications.ai.errors.empty'
        : null;
    if (refusal) {
      return NextResponse.json({ error: refusal }, { status: 409, headers: NO_STORE });
    }

    scheduleAiBatch(request.nextUrl.origin);

    await adminAudit({
      actorId: actor.id,
      action: 'ADMIN_AI_VERIFICATION_TRIGGERED',
      entityType: 'verification_ai_batch',
      after: { queued },
      request,
    });

    return NextResponse.json({ accepted: true, queued }, { status: 202, headers: NO_STORE });
  });
}
