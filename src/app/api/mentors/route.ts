import { NextResponse, type NextRequest } from 'next/server';
import { MentorIndustry, Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getViewer } from '@/lib/auth/session';
import { can } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mentors - the PocketMentor directory.
 *
 * ---------------------------------------------------------------------------
 * ONLY APPROVED PROFILES ARE LISTED
 * ---------------------------------------------------------------------------
 * `isApproved` gates this query and is not a filter the client can turn off.
 * A mentor profile is a claim about someone's employer, seniority and
 * expertise, made to students who will then sit in a one-to-one call with
 * them - so an unreviewed profile must never be discoverable. The same reason
 * the verification pipeline exists at all.
 *
 * The listing is readable while signed out, matching `mentors:browse` in the
 * capability table: browsing is open, BOOKING is what requires a verified
 * identity. The response carries `viewerCanBook` so the UI can say which of
 * the two the reader is looking at, rather than offering a button that will be
 * refused.
 */
const listSchema = z.object({
  q: z.string().trim().max(120).optional(),
  industry: z.nativeEnum(MentorIndustry).optional(),
  sort: z.enum(['rating', 'sessions', 'recent', 'price']).default('rating'),
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest) {
  const viewer = await getViewer();

  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { q, industry, sort, limit, cursor } = parsed.data;

  const where: Prisma.MentorProfileWhereInput = {
    isApproved: true,
    // A mentor who has paused bookings is still worth showing - their profile
    // is real and they may reopen - so this is NOT filtered here. The card
    // shows the paused state instead of hiding the person.
    user: { deletedAt: null, accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } },
    ...(industry ? { industry } : {}),
    ...(q
      ? {
          OR: [
            { headline: { contains: q, mode: 'insensitive' } },
            { about: { contains: q, mode: 'insensitive' } },
            { company: { contains: q, mode: 'insensitive' } },
            { jobTitle: { contains: q, mode: 'insensitive' } },
            // Postgres array containment; matches a whole specialty tag.
            { specialties: { has: q } },
            { user: { nickname: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const orderBy: Prisma.MentorProfileOrderByWithRelationInput[] =
    sort === 'sessions'
      ? [{ sessionsCompleted: 'desc' }, { id: 'asc' }]
      : sort === 'recent'
        ? [{ createdAt: 'desc' }, { id: 'asc' }]
        : sort === 'price'
          ? [{ hourlyRateMinor: 'asc' }, { id: 'asc' }]
          : // Rating, then volume: a lone 5.0 review should not outrank a
            // mentor with fifty sessions at 4.8.
            [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }, { id: 'asc' }];

  const [total, rows] = await db.$transaction([
    db.mentorProfile.count({ where }),
    db.mentorProfile.findMany({
      where,
      orderBy,
      skip: cursor,
      take: limit + 1,
      select: {
        id: true,
        industry: true,
        specialties: true,
        headline: true,
        company: true,
        jobTitle: true,
        yearsExperience: true,
        languages: true,
        hourlyRateMinor: true,
        sessionMinutes: true,
        isAcceptingBookings: true,
        ratingAvg: true,
        ratingCount: true,
        sessionsCompleted: true,
        // `about` is NOT selected: it is up to 4000 characters and the card
        // shows the headline. Pulling it for every row would make the
        // directory page many times heavier than it renders.
        user: {
          select: {
            id: true,
            nickname: true,
            avatarUrl: true,
            isVerified: true,
            university: { select: { code: true } },
          },
        },
      },
    }),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json(
    {
      mentors: page.map((m) => ({
        ...m,
        // Prisma returns Decimal, which serialises as an object rather than a
        // number and would render as "[object Object]" in a rating.
        ratingAvg: Number(m.ratingAvg),
      })),
      total,
      nextCursor: hasMore ? cursor + limit : null,
      /**
       * Whether THIS viewer may book, decided server-side from the capability
       * table. The client uses it to choose between a booking button and a
       * "verify your account first" prompt - it is a UI hint, and the booking
       * endpoint re-checks independently.
       */
      viewerCanBook: can(viewer, 'mentors:book'),
      viewerSignedIn: viewer !== null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
