import { NextResponse, type NextRequest } from 'next/server';
import { MentorIndustry } from '@/lib/enums';
import { z } from 'zod';
import { listMentors } from '@/lib/firebase/repositories/mentors';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds, findUniversityByCode } from '@/lib/firebase/repositories/reference';
import { getViewer } from '@/lib/auth/session';
import { visibleAvatar } from '@/lib/profile/visibility';
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
  university: z.string().trim().max(20).optional(),
  minYears: z.coerce.number().min(0).max(60).optional(),
  maxPrice: z.coerce.number().int().min(0).max(100_000).optional(),
  accepting: z.enum(['1', 'true']).optional(),
});

export async function GET(request: NextRequest) {
  const viewer = await getViewer();

  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { q, industry, sort, limit, cursor, university, minYears, maxPrice, accepting } = parsed.data;

  /**
   * `isApproved` is applied inside listMentors() and is not a parameter.
   *
   * An unreviewed profile is a set of claims about someone's employer and
   * seniority made to students who will then sit in a one-to-one call with
   * them, so it must never be discoverable - and that has to be structural
   * rather than a filter a caller could omit.
   *
   * A mentor who has PAUSED bookings is still listed: their profile is real
   * and they may reopen, so the card shows the paused state instead of hiding
   * the person.
   */
  const { mentors: rows, total } = await listMentors(
    { q, industry, minYears, maxPriceMinor: maxPrice, acceptingOnly: Boolean(accepting) },
    sort,
    cursor,
    limit,
  );

  // University is a property of the mentor's ACCOUNT, so it is applied once
  // the users are loaded. An unknown code matches nobody.
  const universityFilter = university ? await findUniversityByCode(university) : undefined;

  /**
   * The account behind each profile, batched.
   *
   * Prisma resolved `user` with a join, which also let it filter on
   * `deletedAt` and `accountStatus` in the same query. Firestore can do
   * neither, so the accounts are fetched in one batched read and the profiles
   * whose owner is deleted or suspended are dropped afterwards. That filtering
   * is not cosmetic - it is what stops a banned mentor staying in the
   * directory - so it happens before the page is assembled, not in the client.
   */
  const users = await findUsersByIds(rows.map((m) => m.userId));
  const visible = rows.filter((m) => {
    const user = users.get(m.userId);
    if (universityFilter !== undefined && (!universityFilter || user?.universityId !== universityFilter.id)) {
      return false;
    }
    return (
      user && !user.deletedAt && (user.accountStatus === 'ACTIVE' || user.accountStatus === 'RESTRICTED')
    );
  });

  const universities = await findUniversitiesByIds(
    visible
      .map((m) => users.get(m.userId)?.universityId)
      .filter((id): id is string => Boolean(id)),
  );

  const hasMore = visible.length > limit;
  const page = hasMore ? visible.slice(0, limit) : visible;

  return NextResponse.json(
    {
      mentors: page.map((m) => {
        const user = users.get(m.userId);
        const university = user?.universityId ? universities.get(user.universityId) : null;
        return {
          id: m.id,
          industry: m.industry,
          specialties: m.specialties,
          headline: m.headline,
          company: m.company,
          jobTitle: m.jobTitle,
          yearsExperience: m.yearsExperience,
          languages: m.languages,
          hourlyRateMinor: m.hourlyRateMinor,
          sessionMinutes: m.sessionMinutes,
          isAcceptingBookings: m.isAcceptingBookings,
          // Stored as a number in Firestore rather than a Decimal, but coerced
          // anyway: a migrated document may still carry a string.
          ratingAvg: Number(m.ratingAvg),
          ratingCount: m.ratingCount,
          sessionsCompleted: m.sessionsCompleted,
          // `about` is deliberately absent: it is up to 4000 characters and
          // the card shows the headline. Including it for every row would make
          // the directory many times heavier than it renders.
          // No account id: users/{id} also names the owner's wallet,
          // credentials and sessions, and nothing public needs it.
          user: user
            ? {
                nickname: user.nickname,
                avatarUrl: visibleAvatar(user, viewer),
                isVerified: user.isVerified,
                university: university ? { code: university.code } : null,
              }
            : null,
        };
      }),
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
