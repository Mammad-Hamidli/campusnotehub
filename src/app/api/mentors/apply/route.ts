import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { AccountStatus, MentorIndustry, VerificationStatus } from '@/lib/enums';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { findUserById } from '@/lib/firebase/repositories/users';
import { findMentorByUserId } from '@/lib/firebase/repositories/mentors';
import {
  findMentorApplication,
  submitMentorApplication,
} from '@/lib/firebase/repositories/mentorApplications';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { sendEmailAsync } from '@/lib/email/send';
import { timezoneSchema, weeklyRulesSchema } from '@/lib/mentors/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const experienceSchema = z.object({
  company: text(2, 120),
  role: text(2, 120),
  years: z.coerce.number().min(0).max(60),
});

const educationSchema = z.object({
  institution: text(2, 160),
  degree: text(2, 120),
  field: z.string().trim().max(120).optional().nullable(),
  graduationYear: z.coerce.number().int().min(1950).max(2100).optional().nullable(),
});

const applySchema = z.object({
  headline: text(10, 160),
  bio: text(50, 4000),
  industry: z.nativeEnum(MentorIndustry),
  expertise: z.array(text(2, 40)).min(1).max(10),
  experiences: z.array(experienceSchema).min(1).max(10),
  education: z.array(educationSchema).max(5).default([]),
  languages: z.array(z.enum(['az', 'en', 'ru', 'tr'])).min(1).max(4),
  hourlyRateMinor: z.coerce.number().int().min(0).max(50_000),
  sessionMinutes: z.coerce
    .number()
    .int()
    .refine((v) => [30, 45, 60, 90].includes(v)),
  linkedinUrl: z
    .string()
    .trim()
    .max(300)
    .url()
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  /** From the interactive grid; replaces free-text availability. */
  availability: weeklyRulesSchema.refine((rules) => rules.length > 0, 'mentors.schedule.errors.empty'),
  timezone: timezoneSchema.default('Asia/Baku'),
});

async function session(request: NextRequest) {
  try {
    return await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/** GET /api/mentors/apply - the caller's own application status. */
export async function GET(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

  const [application, profile, user] = await Promise.all([
    findMentorApplication(auth.userId),
    findMentorByUserId(auth.userId),
    findUserById(auth.userId),
  ]);

  return NextResponse.json(
    {
      /**
       * The weekly schedule the mentor picked at registration, so the form
       * opens with it instead of an empty grid. A draft only: nothing is
       * bookable until a moderator approves the application.
       */
      draft: user?.mentorAvailability?.length
        ? { availability: user.mentorAvailability, timezone: user.timezone }
        : null,
      application: application
        ? {
            status: application.status,
            submittedAt: application.submittedAt,
            decidedAt: application.decidedAt,
            rejectionReason: application.rejectionReason,
          }
        : null,
      isMentor: Boolean(profile?.isApproved),
      canApply: auth.viewer.verificationStatus === VerificationStatus.VERIFIED,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * POST /api/mentors/apply
 *
 * Submits (or, after a rejection, resubmits) a PocketMentor application. It
 * lands as PENDING and is invisible in the directory until a moderator
 * approves it in the admin panel.
 *
 * Identity verification is required: an approved mentor ends up in one-to-one
 * calls with students, the same reason booking one requires it.
 */
export async function POST(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  const { userId, viewer } = auth;

  if (
    viewer.accountStatus !== AccountStatus.ACTIVE &&
    viewer.accountStatus !== AccountStatus.RESTRICTED
  ) {
    return NextResponse.json({ error: 'errors.forbidden' }, { status: 403 });
  }
  if (viewer.verificationStatus !== VerificationStatus.VERIFIED) {
    return NextResponse.json({ error: 'errors.verificationRequired' }, { status: 403 });
  }

  const limit = await rateLimit('mentors:apply', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = applySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const [existing, profile] = await Promise.all([
    findMentorApplication(userId),
    findMentorByUserId(userId),
  ]);
  if (existing?.status === 'PENDING') {
    return NextResponse.json({ error: 'mentors.apply.errors.pending' }, { status: 409 });
  }
  if (profile?.isApproved) {
    return NextResponse.json({ error: 'mentors.apply.errors.alreadyMentor' }, { status: 409 });
  }

  const input = parsed.data;
  const application = await submitMentorApplication(userId, {
    headline: input.headline,
    bio: input.bio,
    industry: input.industry,
    // De-duplicated case-insensitively; the first spelling wins.
    expertise: [...new Map(input.expertise.map((e) => [e.toLowerCase(), e])).values()],
    experiences: input.experiences,
    education: input.education.map((e) => ({
      institution: e.institution,
      degree: e.degree,
      field: e.field || null,
      graduationYear: e.graduationYear ?? null,
    })),
    languages: [...new Set(input.languages)],
    hourlyRateMinor: input.hourlyRateMinor,
    sessionMinutes: input.sessionMinutes,
    linkedinUrl: input.linkedinUrl ?? null,
    availability: input.availability,
    timezone: input.timezone,
  });

  await writeAuditLog({
    actorId: userId,
    action: 'MENTOR_APPLICATION_SUBMITTED',
    entityType: 'mentor_application',
    entityId: userId,
    after: { industry: input.industry, experiences: input.experiences.length },
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
  });

  const user = await findUserById(userId);
  if (user) {
    sendEmailAsync(user.email, 'mentorApplicationSubmitted', { nickname: user.nickname });
  }

  return NextResponse.json(
    { application: { status: application.status, submittedAt: application.submittedAt } },
    { status: 201 },
  );
}
