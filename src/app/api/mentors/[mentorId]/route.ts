import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
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

  const mentor = await db.mentorProfile.findFirst({
    where: {
      id: mentorId,
      isApproved: true,
      user: { deletedAt: null, accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } },
    },
    select: {
      id: true,
      industry: true,
      specialties: true,
      headline: true,
      // Selected here, unlike the listing, because this IS the page that shows
      // it. The directory deliberately omits it: 4000 characters per row would
      // make a 24-card grid many times heavier than it renders.
      about: true,
      company: true,
      jobTitle: true,
      yearsExperience: true,
      linkedinUrl: true,
      languages: true,
      hourlyRateMinor: true,
      sessionMinutes: true,
      minNoticeHours: true,
      timezone: true,
      isAcceptingBookings: true,
      ratingAvg: true,
      ratingCount: true,
      sessionsCompleted: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          nickname: true,
          avatarUrl: true,
          isVerified: true,
          headline: true,
          bio: true,
          // fullName is NOT selected. The mentor's public handle is what every
          // shared surface renders; the legal name exists for verification and
          // is gated behind the owner's own privacy settings.
          university: { select: { code: true, nameEn: true } },
        },
      },
      reviews: {
        // Newest first, capped: a profile page is not a review archive, and an
        // unbounded include would grow without limit on a popular mentor.
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          rating: true,
          body: true,
          createdAt: true,
          /**
           * The reviewer reaches us through the BOOKING, because a review is
           * tied to a session rather than to a person directly - which is what
           * makes it impossible to review a mentor you never met.
           *
           * Only the public handle is selected. A review is a shared surface,
           * so it renders the nickname like everything else in the product.
           */
          booking: { select: { mentee: { select: { nickname: true, isVerified: true } } } },
        },
      },
      availabilityRules: {
        orderBy: { weekday: 'asc' },
        select: { weekday: true, startMinute: true, endMinute: true },
      },
    },
  });

  if (!mentor) {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  return NextResponse.json(
    {
      mentor: {
        ...mentor,
        // Prisma Decimal serialises as an object and would render as
        // "[object Object]" in a rating.
        ratingAvg: Number(mentor.ratingAvg),
        // Flattened so the client is not walking a join table to find a
        // nickname - the same reason the feed serialiser flattens post tags.
        reviews: mentor.reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          body: r.body,
          createdAt: r.createdAt,
          reviewer: r.booking?.mentee ?? null,
        })),
      },
      viewerCanBook: can(viewer, 'mentors:book'),
      viewerSignedIn: viewer !== null,
      /** True when the viewer IS this mentor - hides "message yourself". */
      viewerIsMentor: viewer?.id === mentor.user.id,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
