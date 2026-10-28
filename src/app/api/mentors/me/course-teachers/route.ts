import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { AccountStatus } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findUserById, updateCourseTeachers, updateUser, type CourseTeacherRecord } from '@/lib/firebase/repositories/users';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { timezoneSchema, weeklyRulesSchema } from '@/lib/mentors/schedule';
import { releaseAvatar } from '@/lib/media/avatars';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function courseOwner(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    const user = await findUserById(auth.userId);
    if (!user) return { response: NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 }) };
    if (user.mentorType !== 'COURSE') return { response: NextResponse.json({ error: 'mentors.join.courseOnly' }, { status: 403 }) };
    if (auth.viewer.accountStatus !== AccountStatus.ACTIVE && auth.viewer.accountStatus !== AccountStatus.RESTRICTED) {
      return { response: NextResponse.json({ error: 'errors.forbidden' }, { status: 403 }) };
    }
    return { auth, user };
  } catch (error) {
    if (error instanceof UnauthorizedError) return { response: NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 }) };
    throw error;
  }
}

const teacherSchema = z.object({
  id: z.string().uuid().optional(),
  fullName: z.string().trim().min(2).max(120),
  specialization: z.string().trim().min(2).max(120),
  bio: z.string().trim().max(2000),
  timezone: timezoneSchema,
  availability: weeklyRulesSchema,
}).strict();

const rosterSchema = z.object({ teachers: z.array(teacherSchema).min(2).max(30) }).strict().superRefine(({ teachers }, ctx) => {
  const ids = teachers.flatMap((teacher) => teacher.id ? [teacher.id] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['teachers'], message: 'errors.validationFailed' });
});

/** GET /api/mentors/me/course-teachers - course account instructor settings. */
export async function GET(request: NextRequest) {
  const owner = await courseOwner(request);
  if ('response' in owner) return owner.response;
  const current = owner.user.courseTeachers ?? [];
  const teachers: CourseTeacherRecord[] = current.map((teacher) => ({
    id: typeof teacher.id === 'string' ? teacher.id : randomUUID(),
    fullName: typeof teacher.fullName === 'string' ? teacher.fullName : '',
    specialization: typeof teacher.specialization === 'string' ? teacher.specialization : '',
    bio: typeof teacher.bio === 'string' ? teacher.bio : '',
    avatarUrl: typeof teacher.avatarUrl === 'string' ? teacher.avatarUrl : null,
    timezone: typeof teacher.timezone === 'string' ? teacher.timezone : 'Asia/Baku',
    availability: Array.isArray(teacher.availability) ? teacher.availability : [],
  }));
  const needsNormalization = current.some((teacher) =>
    typeof teacher.id !== 'string' || typeof teacher.avatarUrl !== 'string' && teacher.avatarUrl !== null ||
    typeof teacher.timezone !== 'string' || !Array.isArray(teacher.availability),
  );
  if (needsNormalization) await updateUser(owner.auth.userId, { courseTeachers: teachers });
  return NextResponse.json({ teachers }, { headers: { 'Cache-Control': 'private, no-store' } });
}

/** PUT /api/mentors/me/course-teachers { teachers: [...] } - save team profile/timetable settings. */
export async function PUT(request: NextRequest) {
  const owner = await courseOwner(request);
  if ('response' in owner) return owner.response;
  const limit = await rateLimit('mentors:schedule', { userId: owner.auth.userId, ip: clientIp(request.headers) });
  if (!limit.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });

  const parsed = rosterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors }, { status: 400 });

  // Pictures come from the stored row at commit time, never from the client.
  const written = await updateCourseTeachers(owner.auth.userId, (current) => {
    const byId = new Map(current.map((teacher) => [teacher.id, teacher]));
    return parsed.data.teachers.map((teacher) => {
      const id = teacher.id ?? randomUUID();
      return { ...teacher, id, avatarUrl: byId.get(id)?.avatarUrl ?? null };
    });
  });
  if (!written) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  const [existing, teachers] = written;
  const retained = new Set(teachers.map((teacher) => teacher.id));
  await Promise.all(existing.filter((teacher) => !retained.has(teacher.id)).map((teacher) => releaseAvatar(owner.auth.userId, teacher.avatarUrl)));
  return NextResponse.json({ teachers }, { headers: { 'Cache-Control': 'no-store' } });
}
