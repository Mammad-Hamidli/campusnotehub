import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { findMentorById, listMentors } from '@/lib/firebase/repositories/mentors';
import { findUserById, findUsersByIds } from '@/lib/firebase/repositories/users';
import { getFeedAdMentorId, setFeedAdMentorId } from '@/lib/firebase/repositories/feedAd';
import { isPubliclyVisible } from '@/lib/profile/visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Plenty for a hand-picked promotion list; the directory scan has its own ceiling. */
const CANDIDATE_LIMIT = 200;

/**
 * GET /api/admin/feed-ad - the promoted mentor id and every mentor that could
 * take the slot: approved profiles whose account is publicly visible.
 *
 * MODERATOR tier, like mentor applications: the people who approve mentors
 * decide which one is featured.
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const [current, { mentors }] = await Promise.all([
      getFeedAdMentorId(),
      listMentors({}, 'recent', 0, CANDIDATE_LIMIT),
    ]);
    const users = await findUsersByIds(mentors.map((m) => m.userId));

    const candidates = mentors.flatMap((m) => {
      const user = users.get(m.userId);
      if (!isPubliclyVisible(user)) return [];
      return [{
        id: m.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl ?? null,
        isVerified: user.isVerified,
        headline: m.headline,
        industry: m.industry,
        isAcceptingBookings: m.isAcceptingBookings,
      }];
    });

    return NextResponse.json(
      { current, mentors: candidates.slice(0, CANDIDATE_LIMIT) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}

const putSchema = z.object({ mentorId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable() });

/**
 * PUT /api/admin/feed-ad { mentorId | null } - promote one mentor (replacing
 * whoever held the slot) or empty it. One request per click in the panel.
 */
export async function PUT(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    }
    const { mentorId } = parsed.data;

    if (mentorId) {
      const mentor = await findMentorById(mentorId);
      const owner = mentor?.isApproved ? await findUserById(mentor.userId) : null;
      if (!isPubliclyVisible(owner)) {
        return NextResponse.json({ error: 'admin.feedAd.errors.notEligible' }, { status: 409 });
      }
    }

    const before = await getFeedAdMentorId();
    await setFeedAdMentorId(mentorId, actor.id);
    await adminAudit({
      actorId: actor.id,
      action: mentorId ? 'ADMIN_FEED_AD_SET' : 'ADMIN_FEED_AD_CLEARED',
      entityType: 'mentorProfile',
      entityId: mentorId ?? before ?? undefined,
      before: { mentorId: before },
      after: { mentorId },
      request,
    });

    return NextResponse.json({ current: mentorId });
  });
}
