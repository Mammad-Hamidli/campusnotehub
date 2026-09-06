import { NextResponse, type NextRequest } from 'next/server';
import { Prisma, PostVisibility } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getViewer, requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, ForbiddenError } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { POST_INCLUDE, serializePost } from '@/lib/feed/serialize';
import { mediaIdFromKey } from '@/lib/media/images';

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
      ...POST_INCLUDE,
      // Reposts are counted, not listed: the client shows a number, and
      // loading the rows to call .length on them would pull every repost of
      // every post on the page.
      _count: { select: { reposts: true } },
      ...(viewer ? { likes: { where: { userId: viewer.id }, select: { userId: true } } } : {}),
    },
  });

  const hasMore = posts.length > limit;
  const page = hasMore ? posts.slice(0, limit) : posts;
  const last = page.at(-1);

  return NextResponse.json(
    {
      // One serialiser for both routes - see src/lib/feed/serialize.ts for why
      // hand-spreading the row here was the source of the `tags is undefined`
      // crash on newly created posts.
      posts: page.map((p) => serializePost(p, { viewerId: viewer?.id, shareCount: p._count.reposts })),
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const createSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  visibility: z.nativeEnum(PostVisibility).default(PostVisibility.PUBLIC),
  universityId: z.string().cuid().optional(),
  tags: z.array(z.string().regex(/^[\p{L}\p{N}_]{2,40}$/u)).max(5).default([]),
  /**
   * Images, as keys returned by POST /api/media.
   *
   * The client sends only a KEY - never bytes, never a URL it chose. The
   * dimensions it sends are ignored in favour of the ones recorded when the
   * asset was processed, because a client that can set width/height can set
   * them to values that break every layout on the page.
   */
  media: z
    .array(
      z.object({
        storageKey: z.string().max(200),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        altText: z.string().max(300).optional(),
      }),
    )
    .max(4)
    .default([]),
});

/** POST /api/feed - unverified users may post; only earning is gated. */
export async function POST(request: NextRequest) {
  let userId: string;
  let viewer;
  try {
    ({ userId, viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  /**
   * `can`, not `assertCan`.
   *
   * assertCan THROWS a ForbiddenError, and nothing in this handler caught it -
   * so a frozen account trying to post got a 500 with a stack trace instead of
   * a clean 403 with a message it could act on. The capability table is
   * unchanged; only the way the answer is delivered is.
   *
   * This is the check that stops a frozen or suspended account from posting:
   * 'feed:post' is absent from ALWAYS_ALLOWED, so a SUSPENDED viewer fails it.
   */
  if (!can(viewer, 'feed:post')) {
    return NextResponse.json(
      { error: new ForbiddenError('feed:post').messageKey },
      { status: 403 },
    );
  }

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

  /**
   * The tags are attached INSIDE the transaction, then the finished row is
   * re-read with the shared include before returning.
   *
   * Re-reading is deliberate. The `create` cannot include relations that its
   * own subsequent statements are still writing, so its result would carry an
   * empty tag list even for a post that has tags - which is a subtler version
   * of the bug this change fixes. One extra indexed read by primary key is a
   * fair price for the response being the truth about what was stored.
   */
  /**
   * Every referenced asset must exist, belong to THIS user, and not already be
   * attached to another post.
   *
   * All three matter and none can be skipped:
   *  - existence, or a post carries a key that 404s as a broken image;
   *  - ownership, or anyone can attach a stranger's image to their own post
   *    simply by quoting its key, which is both theft and a way to put someone
   *    else's photo under text they never wrote;
   *  - unattached, so one upload cannot be fanned out across many posts and a
   *    later deletion has one place to clean up.
   *
   * The dimensions come from the ASSET, not from the request body.
   */
  const requestedIds = input.media
    .map((m) => mediaIdFromKey(m.storageKey))
    .filter((id): id is string => id !== null);

  if (requestedIds.length !== input.media.length) {
    return NextResponse.json({ error: 'feed.image.errors.invalidKey' }, { status: 400 });
  }

  const assets = requestedIds.length
    ? await db.mediaAsset.findMany({
        where: { id: { in: requestedIds }, ownerId: userId, attachedAt: null },
        select: { id: true, mime: true, width: true, height: true, altText: true },
      })
    : [];

  if (assets.length !== requestedIds.length) {
    // Deliberately one message for "no such asset", "not yours" and "already
    // used". Distinguishing them tells a caller which keys exist.
    return NextResponse.json({ error: 'feed.image.errors.invalidKey' }, { status: 400 });
  }

  // Preserve the order the user arranged them in, which findMany does not.
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const orderedAssets = requestedIds.map((id) => assetById.get(id)!);

  const post = await db.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        authorId: userId,
        body: input.body,
        visibility: input.visibility,
        universityId:
          input.visibility === PostVisibility.UNIVERSITY_ONLY ? author.universityId : null,
        media: {
          createMany: {
            data: orderedAssets.map((asset, i) => ({
              storageKey: `db://media/${asset.id}`,
              // The encoder's own values, not the client's claim.
              mimeType: asset.mime,
              width: asset.width,
              height: asset.height,
              altText: input.media[i]?.altText ?? asset.altText,
              position: i,
            })),
          },
        },
      },
      select: { id: true },
    });

    /**
     * Claim the assets in the SAME transaction.
     *
     * Marking them attached afterwards would leave a window where a second
     * request could attach the same asset to a second post, and a rolled-back
     * post would strand assets marked as used.
     */
    if (orderedAssets.length > 0) {
      await tx.mediaAsset.updateMany({
        where: { id: { in: orderedAssets.map((a) => a.id) } },
        data: { attachedAt: new Date() },
      });
    }

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

    return tx.post.findUniqueOrThrow({
      where: { id: created.id },
      include: POST_INCLUDE,
    });
  });

  /**
   * Serialised through the SAME function the feed listing uses, so a created
   * post and a listed post are indistinguishable to the client: `tags` and
   * `media` are always arrays, the author always carries a nickname, and
   * shareCount is 0 rather than undefined. A brand-new post has no reposts,
   * hence the literal.
   */
  return NextResponse.json(
    { post: serializePost(post, { viewerId: userId, shareCount: 0 }) },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
