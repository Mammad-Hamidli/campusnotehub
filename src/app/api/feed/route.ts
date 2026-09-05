import { NextResponse, type NextRequest } from 'next/server';
import { Prisma, PostVisibility } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getViewer, requireSession } from '@/lib/auth/session';
import { assertCan } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';

const querySchema = z.object({
  /** Keyset cursor: "<iso timestamp>_<postId>". */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  filter: z.enum(['all', 'university', 'following']).default('all'),
  tag: z.string().max(50).optional(),
  universityId: z.string().cuid().optional(),
});

/**
 * GET /api/feed
 *
 * Keyset pagination, not OFFSET. An offset-paginated feed re-reads and
 * discards every earlier row on each page, so page 50 costs fifty times page
 * 1, and any post created mid-scroll shifts the window and duplicates or skips
 * an item. The composite (createdAt DESC, id DESC) index makes each page a
 * bounded index scan regardless of depth.
 */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  const params = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { cursor, limit, filter, tag, universityId } = params.data;

  const rate = await rateLimit('search', { userId: viewer?.id, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const [cursorTime, cursorId] = cursor ? cursor.split('_') : [];

  // The viewer's own university comes from their record, never from the query
  // string. Trusting `?universityId=` here would let anyone read another
  // university's private feed by editing the URL.
  const viewerUniversityId = viewer
    ? (await db.user.findUnique({ where: { id: viewer.id }, select: { universityId: true } }))
        ?.universityId ?? null
    : null;

  // Visibility is enforced in the query, never by filtering the result set in
  // JS - a post the viewer may not see must never leave the database.
  // Clauses are built by pushing rather than by neutralising a clause with a
  // sentinel id, so an unmet condition is genuinely absent from the SQL.
  let visibilityWhere: Prisma.PostWhereInput = { visibility: PostVisibility.PUBLIC };

  if (viewer) {
    const clauses: Prisma.PostWhereInput[] = [
      { visibility: PostVisibility.PUBLIC },
      { authorId: viewer.id },
      { visibility: PostVisibility.FOLLOWERS, author: { followers: { some: { followerId: viewer.id } } } },
    ];
    if (viewer.verificationStatus === 'VERIFIED') {
      clauses.push({ visibility: PostVisibility.VERIFIED_ONLY });
    }
    if (viewerUniversityId) {
      clauses.push({ visibility: PostVisibility.UNIVERSITY_ONLY, universityId: viewerUniversityId });
    }
    visibilityWhere = { OR: clauses };
  }

  const posts = await db.post.findMany({
    where: {
      isDeleted: false,
      // Content from banned accounts disappears without a separate cleanup job.
      author: { accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } },
      ...visibilityWhere,
      // The `university` filter narrows to the viewer's own university feed.
      // An explicit ?universityId= is only honoured for browsing another
      // university's PUBLIC posts, which the visibility clause already limits.
      ...(filter === 'university' && viewer
        ? { universityId: viewerUniversityId ?? undefined }
        : universityId
          ? { universityId }
          : {}),
      ...(filter === 'following' && viewer
        ? { author: { followers: { some: { followerId: viewer.id } } } }
        : {}),
      ...(tag ? { tags: { some: { tag: { slug: tag.toLowerCase() } } } } : {}),
      ...(cursorTime && cursorId
        ? {
            OR: [
              { createdAt: { lt: new Date(cursorTime) } },
              { createdAt: new Date(cursorTime), id: { lt: cursorId } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1, // one extra row tells us whether another page exists
    include: {
      author: {
        select: {
          id: true, fullName: true, avatarUrl: true, role: true,
          isVerified: true, headline: true,
          university: { select: { code: true, nameAz: true, nameEn: true, nameRu: true } },
        },
      },
      media: { orderBy: { position: 'asc' } },
      tags: { include: { tag: { select: { slug: true, label: true } } } },
      ...(viewer ? { likes: { where: { userId: viewer.id }, select: { userId: true } } } : {}),
    },
  });

  const hasMore = posts.length > limit;
  const page = hasMore ? posts.slice(0, limit) : posts;
  const last = page.at(-1);

  return NextResponse.json({
    posts: page.map((p) => ({
      ...p,
      likedByViewer: 'likes' in p ? (p.likes as unknown[]).length > 0 : false,
      likes: undefined,
    })),
    nextCursor: hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
  });
}

const createSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  visibility: z.nativeEnum(PostVisibility).default(PostVisibility.PUBLIC),
  universityId: z.string().cuid().optional(),
  tags: z.array(z.string().regex(/^[\p{L}\p{N}_]{2,40}$/u)).max(5).default([]),
  media: z
    .array(z.object({ storageKey: z.string(), width: z.number().int(), height: z.number().int(), altText: z.string().max(300).optional() }))
    .max(4)
    .default([]),
});

/** POST /api/feed - unverified users may post; only earning is gated. */
export async function POST(request: NextRequest) {
  const { userId, viewer } = await requireSession(request);
  assertCan(viewer, 'feed:post');

  const rate = await rateLimit('feed:post', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const input = parsed.data;

  // UNIVERSITY_ONLY must resolve to the author's own university; accepting a
  // client-supplied id would let anyone post into any university's feed.
  const author = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { universityId: true },
  });

  const post = await db.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        authorId: userId,
        body: input.body,
        visibility: input.visibility,
        universityId:
          input.visibility === PostVisibility.UNIVERSITY_ONLY ? author.universityId : null,
        media: { createMany: { data: input.media.map((m, i) => ({ ...m, mimeType: 'image/webp', position: i })) } },
      },
      include: { author: { select: { id: true, fullName: true, avatarUrl: true, isVerified: true } } },
    });

    for (const raw of input.tags) {
      const slug = raw.toLocaleLowerCase('az');
      const tag = await tx.tag.upsert({
        where: { slug },
        create: { slug, label: raw },
        update: { usageCount: { increment: 1 } },
      });
      if (!tag.isBlocked) {
        await tx.postTag.create({ data: { postId: created.id, tagId: tag.id } });
      }
    }

    return created;
  });

  return NextResponse.json({ post }, { status: 201 });
}
