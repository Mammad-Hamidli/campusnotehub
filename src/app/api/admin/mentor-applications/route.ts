import { NextResponse, type NextRequest } from 'next/server';
import { withAdmin } from '@/lib/auth/admin';
import {
  listMentorApplications,
  totalYears,
  type MentorApplicationStatus,
} from '@/lib/firebase/repositories/mentorApplications';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: MentorApplicationStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];

/** GET /api/admin/mentor-applications?status=PENDING */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const requested = request.nextUrl.searchParams.get('status') as MentorApplicationStatus | null;
    const status = requested && STATUSES.includes(requested) ? requested : 'PENDING';

    const applications = await listMentorApplications(status);
    const users = await findUsersByIds(applications.map((a) => a.userId));
    const universities = await findUniversitiesByIds(
      [...users.values()].map((u) => u.universityId).filter((id): id is string => Boolean(id)),
    );

    return NextResponse.json(
      {
        applications: applications.map((a) => {
          const user = users.get(a.userId);
          const university = user?.universityId ? universities.get(user.universityId) : null;
          return {
            userId: a.userId,
            status: a.status,
            headline: a.headline,
            bio: a.bio,
            industry: a.industry,
            expertise: a.expertise,
            experiences: a.experiences,
            education: a.education,
            languages: a.languages,
            hourlyRateMinor: a.hourlyRateMinor,
            sessionMinutes: a.sessionMinutes,
            linkedinUrl: a.linkedinUrl,
            totalYears: totalYears(a.experiences),
            submittedAt: a.submittedAt,
            decidedAt: a.decidedAt,
            rejectionReason: a.rejectionReason,
            applicant: user
              ? {
                  nickname: user.nickname,
                  fullName: user.fullName,
                  email: user.email,
                  verificationStatus: user.verificationStatus,
                  university: university?.code ?? null,
                }
              : null,
          };
        }),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
