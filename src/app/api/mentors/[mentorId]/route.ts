import { NextResponse, type NextRequest } from 'next/server';
import {
  findMentorById,
  findViewerMentorReview,
  listAvailabilityRules,
  listReviewsForMentor,
} from '@/lib/firebase/repositories/mentors';
import { findUserById, findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversityById } from '@/lib/firebase/repositories/reference';
import { getViewer } from '@/lib/auth/session';
import { can } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mentors/:mentorId - one mentor profile.
 *
 * Readable while signed out, matching `mentors:browse` in the capability
 * table: browsing is open, BOOKING is what requires a verified identity. The
 * response carries `viewerCanBook` so the page renders the control the reader
 * can actually use rather than one that will be refused.
 *
 * Only APPROVED profiles resolve. An unreviewed profile is a set of claims
 * about someone's employer and seniority made to students who will then sit in
 * a one-to-one call with them, so it must not be reachable by guessing an id
 * any more than by browsing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ mentorId: string }> },
) {
  const { mentorId } = await params;
  const viewer = await getViewer();

  const mentor = await findMentorById(mentorId);

  /**
   * Only APPROVED profiles resolve, and only for a live account.
   *
   * Prisma expressed both halves in one `findFirst` with a joined `user`
   * predicate. Firestore cannot filter on a joined document, so the account is
   * read separately and the same two conditions are applied here. They are not
   * optional: an unreviewed profile is a set of claims about someone's
   * employer and seniority made to students who will then sit in a one-to-one
   * call with them, so it must not be reachable by guessing an id any more
   * than by browsing.
   */
  if (!mentor || !mentor.isApproved) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const owner = await findUserById(mentor.userId);
  const ownerVisible =
    owner &&
    !owner.deletedAt &&
    (owner.accountStatus === 'ACTIVE' || owner.accountStatus === 'RESTRICTED');

  if (!owner || !ownerVisible) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  // Reviews, availability and the mentor's university: three independent reads
  // that the `include` used to fold into one query. Issued concurrently.
  // The mentor cannot review themselves, and a signed-out reader has no
  // sessions; neither costs a read.
  const viewerReview =
    viewer && viewer.id !== owner.id ? await findViewerMentorReview(mentor.id, viewer.id) : null;

  const [reviews, availabilityRules, university] = await Promise.all([
    // Newest first, capped: a profile page is not a review archive, and an
    // unbounded read would grow without limit on a popular mentor.
    listReviewsForMentor(mentor.id, 10),
    listAvailabilityRules(mentor.id),
    owner.universityId ? findUniversityById(owner.universityId) : Promise.resolve(null),
  ]);

  /**
   * The reviewer handles.
   *
   * A review is tied to a BOOKING rather than to a person directly - which is
   * what makes it impossible to review a mentor you never met - and the SQL
   * walked `review -> booking -> mentee` to reach the handle. The review
   * document carries `menteeId` directly, so that two-hop join becomes one
   * batched read.
   *
   * Only the public handle is exposed. A review is a shared surface, so it
   * renders the nickname like everything else in the product.
   */
  const reviewers = await findUsersByIds(reviews.map((r) => r.menteeId));

  return NextResponse.json(
    {
      /**
       * An explicit allow-list, not `...mentor`. Spreading the stored record
       * published `userId` (the owner's account id) plus internal fields such
       * as `isApproved`, `approvedAt` and `bufferMinutes` on an endpoint that
       * is readable signed out. `id` stays: it is the profile's own random id
       * and the key /mentors/[mentorId] and booking are routed by.
       */
      mentor: {
        id: mentor.id,
        industry: mentor.industry,
        specialties: mentor.specialties,
        headline: mentor.headline,
        about: mentor.about,
        company: mentor.company,
        jobTitle: mentor.jobTitle,
        yearsExperience: mentor.yearsExperience,
        linkedinUrl: mentor.linkedinUrl,
        languages: mentor.languages,
        hourlyRateMinor: mentor.hourlyRateMinor,
        sessionMinutes: mentor.sessionMinutes,
        minNoticeHours: mentor.minNoticeHours,
        timezone: mentor.timezone,
        isAcceptingBookings: mentor.isAcceptingBookings,
        ratingAvg: Number(mentor.ratingAvg),
        ratingCount: mentor.ratingCount,
        sessionsCompleted: mentor.sessionsCompleted,
        user: {
          nickname: owner.nickname,
          avatarUrl: owner.avatarUrl,
          isVerified: owner.isVerified,
          headline: owner.headline,
          bio: owner.bio,
          // fullName is NOT included. The mentor's public handle is what every
          // shared surface renders; the legal name exists for verification and
          // is gated behind the owner's own privacy settings.
          university: university ? { code: university.code, nameEn: university.nameEn } : null,
        },
        availabilityRules: availabilityRules.map((r) => ({
          weekday: r.weekday,
          startMinute: r.startMinute,
          endMinute: r.endMinute,
        })),
        // Flattened so the client is not walking a join to find a nickname -
        // the same reason the feed serialiser flattens post tags.
        reviews: reviews.map((r) => {
          const reviewer = reviewers.get(r.menteeId);
          return {
            id: r.id,
            rating: r.rating,
            body: r.body,
            createdAt: r.createdAt,
            reviewer: reviewer
              ? { nickname: reviewer.nickname, isVerified: reviewer.isVerified }
              : null,
          };
        }),
      },
      viewerCanBook: can(viewer, 'mentors:book'),
      /**
       * The review box: shown when the viewer has had a finished session with
       * this mentor, pre-filled with their own review. The PUT re-checks the
       * session inside its transaction; this is display only.
       */
      viewerReview: viewerReview ?? { eligible: false, rating: null, body: null },
      viewerSignedIn: viewer !== null,
      /** True when the viewer IS this mentor - hides "message yourself". */
      viewerIsMentor: viewer?.id === owner.id,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
