import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  findMentorByUserId,
  listAvailabilityExceptions,
  listAvailabilityRules,
  saveMentorSchedule,
} from '@/lib/firebase/repositories/mentors';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { blockedDatesSchema, timezoneSchema, weeklyRulesSchema } from '@/lib/mentors/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET/PUT /api/mentors/me/schedule - the signed-in mentor's own availability.
 *
 * Scoped by session userId -> mentorProfiles.userId; there is no mentorId
 * parameter to tamper with. Only approved profiles are editable.
 */
async function ownProfile(request: NextRequest) {
  try {
    const { userId, viewer } = await requireSession(request);
    const mentor = await findMentorByUserId(userId);
    return { userId, viewer, mentor: mentor?.isApproved ? mentor : null };
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export async function GET(request: NextRequest) {
  const auth = await ownProfile(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  if (!auth.mentor) return NextResponse.json({ error: 'mentors.schedule.notMentor' }, { status: 404 });

  const { mentor } = auth;
  const [rules, exceptions] = await Promise.all([
    listAvailabilityRules(mentor.id),
    listAvailabilityExceptions(mentor.id),
  ]);

  return NextResponse.json(
    {
      mentorId: mentor.id,
      timezone: mentor.timezone,
      isAcceptingBookings: mentor.isAcceptingBookings,
      bufferMinutes: mentor.bufferMinutes,
      minNoticeHours: mentor.minNoticeHours,
      rules: rules.map(({ weekday, startMinute, endMinute }) => ({ weekday, startMinute, endMinute })),
      blocked: exceptions
        .filter((e) => e.isBlocked)
        .map((e) => ({ date: e.date.toISOString().slice(0, 10), startMinute: e.startMinute, endMinute: e.endMinute }))
        .filter((b) => b.date >= today())
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

const putSchema = z.object({
  timezone: timezoneSchema,
  rules: weeklyRulesSchema,
  blocked: blockedDatesSchema,
  isAcceptingBookings: z.boolean(),
  bufferMinutes: z.number().int().refine((v) => [0, 5, 10, 15, 30].includes(v)),
  minNoticeHours: z.number().int().min(0).max(168),
});

export async function PUT(request: NextRequest) {
  const auth = await ownProfile(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  if (!auth.mentor) return NextResponse.json({ error: 'mentors.schedule.notMentor' }, { status: 404 });

  const limit = await rateLimit('mentors:schedule', { userId: auth.userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const input = parsed.data;
  await saveMentorSchedule(auth.mentor.id, {
    rules: input.rules,
    blocked: input.blocked.filter((b) => b.date >= today()),
    profile: {
      timezone: input.timezone,
      isAcceptingBookings: input.isAcceptingBookings,
      bufferMinutes: input.bufferMinutes,
      minNoticeHours: input.minNoticeHours,
    },
  });

  await writeAuditLog({
    actorId: auth.userId,
    action: 'MENTOR_SCHEDULE_UPDATED',
    entityType: 'mentor_profile',
    entityId: auth.mentor.id,
    after: { rules: input.rules.length, blocked: input.blocked.length, accepting: input.isAcceptingBookings },
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
  });

  return NextResponse.json({ ok: true, rules: input.rules }, { headers: { 'Cache-Control': 'no-store' } });
}
