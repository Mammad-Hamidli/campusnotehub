import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findUserById, updateCourseTeachers, type CourseTeacherRecord } from '@/lib/firebase/repositories/users';
import { IMAGE_REJECTION_KEY, MAX_IMAGE_BYTES, processAvatar } from '@/lib/media/images';
import { avatarUrlFor, releaseAvatar, storeAvatar } from '@/lib/media/avatars';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST /api/mentors/me/course-teachers/:teacherId/avatar { file } */
export async function POST(request: NextRequest, { params }: { params: Promise<{ teacherId: string }> }) {
  let auth;
  try { auth = await requireSession(request); } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    throw error;
  }
  const user = await findUserById(auth.userId);
  if (!user) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  if (user.mentorType !== 'COURSE') return NextResponse.json({ error: 'mentors.join.courseOnly' }, { status: 403 });
  if (auth.viewer.accountStatus !== AccountStatus.ACTIVE && auth.viewer.accountStatus !== AccountStatus.RESTRICTED) return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });

  const { teacherId } = await params;
  const teachers = user.courseTeachers ?? [];
  const index = teachers.findIndex((teacher) => teacher.id === teacherId);
  if (index < 0) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const limit = await rateLimit('profile:avatar', { userId: auth.userId, ip: clientIp(request.headers) });
  if (!limit.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data')) return NextResponse.json({ error: 'errors.unsupportedMediaType' }, { status: 415 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES + 1024 * 1024) return NextResponse.json({ error: 'feed.image.errors.tooLarge' }, { status: 413 });

  const file = (await request.formData()).get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'feed.image.errors.missing' }, { status: 400 });
  if (file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: 'feed.image.errors.tooLarge' }, { status: 413 });
  const input = Buffer.from(await file.arrayBuffer());
  try {
    const verdict = await processAvatar(input);
    if (!verdict.ok) return NextResponse.json({ error: IMAGE_REJECTION_KEY[verdict.reason] }, { status: 400 });
    const asset = await storeAvatar(auth.userId, verdict.image);
    const avatarUrl = avatarUrlFor(asset.id);
    const written = await updateCourseTeachers(auth.userId, (current) => withAvatar(current, teacherId, avatarUrl));
    if (!written) {
      // The teacher was removed while the picture was being processed.
      await releaseAvatar(auth.userId, avatarUrl);
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
    await releaseAvatar(auth.userId, written[0].find((teacher) => teacher.id === teacherId)?.avatarUrl ?? null);
    return NextResponse.json({ avatarUrl }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[course-teacher-avatar] upload failed', error);
    return NextResponse.json({ error: 'feed.image.errors.uploadFailed' }, { status: 502 });
  } finally {
    input.fill(0);
  }
}

/** DELETE /api/mentors/me/course-teachers/:teacherId/avatar */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ teacherId: string }> }) {
  let auth;
  try { auth = await requireSession(request); } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    throw error;
  }
  const user = await findUserById(auth.userId);
  if (!user) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  if (user.mentorType !== 'COURSE') return NextResponse.json({ error: 'mentors.join.courseOnly' }, { status: 403 });
  if (auth.viewer.accountStatus !== AccountStatus.ACTIVE && auth.viewer.accountStatus !== AccountStatus.RESTRICTED) return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  const { teacherId } = await params;
  const teachers = user.courseTeachers ?? [];
  const index = teachers.findIndex((teacher) => teacher.id === teacherId);
  if (index < 0) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  const written = await updateCourseTeachers(auth.userId, (current) => withAvatar(current, teacherId, null));
  if (!written) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  await releaseAvatar(auth.userId, written[0].find((teacher) => teacher.id === teacherId)?.avatarUrl ?? null);
  return NextResponse.json({ avatarUrl: null });
}

/** The list with one teacher's picture replaced, or null when that teacher is gone. */
function withAvatar(teachers: CourseTeacherRecord[], teacherId: string, avatarUrl: string | null) {
  const index = teachers.findIndex((teacher) => teacher.id === teacherId);
  if (index < 0) return null;
  const next = [...teachers];
  next[index] = { ...next[index], avatarUrl };
  return next;
}
