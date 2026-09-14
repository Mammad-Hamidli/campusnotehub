import { NextResponse, type NextRequest } from 'next/server';
import { PostVisibility } from '@/lib/enums';
import { z } from 'zod';
import { getViewer, requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, ForbiddenError } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { toPlainText } from '@/lib/security/plainText';
import { serializePost } from '@/lib/feed/serialize';
import { resolveViewerAudience } from '@/lib/feed/visibility';
import { createPost, feedPage, likedPostIds, newPostId } from '@/lib/firebase/repositories/posts';
import { findUserById, findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { followingIds } from '@/lib/firebase/repositories/follows';
import { claimMediaAssets } from '@/lib/firebase/repositories/media';
import { upsertTags } from '@/lib/firebase/repositories/tags';
import { mediaIdFromKey } from '@/lib/media/images';

export const runtime = 'nodejs';

const querySchema = z.object({
  /** Keyset cursor: "<iso timestamp>_<postId>". */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  filter: z.enum(['all', 'university', 'following']).default('all'),
  tag: z.string().max(50).optional(),
  universityId: z.string().min(1).max(64).optional(),
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

  const [cursorTime] = cursor ? cursor.split('_') : [];

  /**
   * The viewer's entitlements, resolved from their OWN record.
   *
   * Never from the query string: trusting `?universityId=` here would let
   * anyone read another university's private feed by editing the URL. This
   * returns the audience tokens that replace the old SQL `OR` - see
   * src/lib/feed/audience.ts.
   */
  const audience = await resolveViewerAudience(viewer);

  /**
   * The `university` tab narrows to the viewer's own university feed. An
   * explicit ?universityId= is only honoured for browsing another
   * university's PUBLIC posts, which the audience tokens already limit - a
   * viewer without a UNI token for that institution simply matches none of
   * its UNIVERSITY_ONLY posts.
   */
  const narrowUniversityId =
    filter === 'university' && viewer ? audience.universityId : (universityId ?? null);

  // The `following` tab is a presentation filter over posts the viewer may
  // already see; it is not a security boundary (the tokens are).
  const followedAuthors =
    filter === 'following' && viewer ? await followingIds(viewer.id) : null;

  const { rows, hasMore } = await feedPage({
    tokens: audience.tokens,
    limit,
    before: cursorTime ? new Date(cursorTime) : null,
    universityId: narrowUniversityId,
    authorIds: followedAuthors,
    tagSlug: tag ? tag.toLowerCase() : null,
  });

  /**
   * The authors, their universities, and the viewer's likes - three batched
   * reads that replace what Prisma expressed as one `include`.
   *
   * Firestore has no joins, so decorating a page is: collect the ids, fetch
   * them in batches of 30, and index the results. That is a fixed handful of
   * round trips per page rather than one per post, which is the N+1 the old
   * `include` was avoiding.
   */
  const authors = await findUsersByIds(rows.map((p) => p.authorId));

  const [universities, liked] = await Promise.all([
    findUniversitiesByIds(
      [...authors.values()].map((a) => a.universityId).filter((id): id is string => Boolean(id)),
    ),
    viewer ? likedPostIds(rows.map((p) => p.id), viewer.id) : Promise.resolve(new Set<string>()),
  ]);

  /**
   * Content from banned accounts disappears without a separate cleanup job.
   *
   * This was `author: { accountStatus: { in: [...] } }` on the SQL join.
   * Firestore cannot filter a query by a field on a different document, so it
   * is applied here, after the authors are loaded. The page can therefore come
   * back shorter than `limit` - which is why `nextCursor` is derived from the
   * LAST ROW READ rather than from the last row shown: the cursor must
   * describe where the scan reached, not where the filtered list ended, or a
   * page whose posts were all filtered out would loop forever on the same
   * cursor.
   */
  const visible = rows.filter((post) => {
    const author = authors.get(post.authorId);
    return Boolean(
      author &&
        !author.deletedAt &&
        (author.accountStatus === 'ACTIVE' || author.accountStatus === 'RESTRICTED'),
    );
  });

  const lastScanned = rows.at(-1);

  return NextResponse.json(
    {
      // One serialiser for both routes - see src/lib/feed/serialize.ts for why
      // hand-spreading the row here was the source of the `tags is undefined`
      // crash on newly created posts.
      posts: visible.map((post) => {
        const author = authors.get(post.authorId) ?? null;
        return serializePost(post, {
          author,
          university: author?.universityId
            ? universities.get(author.universityId) ?? null
            : null,
          viewerId: viewer?.id,
          likedByViewer: liked.has(post.id),
        });
      }),
      nextCursor:
        hasMore && lastScanned
          ? `${lastScanned.createdAt.toISOString()}_${lastScanned.id}`
          : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const createSchema = z.object({
  // Sanitised BEFORE the length checks, so a body that is only markup is
  // rejected as empty. The pre-transform max bounds the sanitiser's work.
  body: z.string().max(4000).transform(toPlainText).pipe(z.string().min(1).max(2000)),
  visibility: z.nativeEnum(PostVisibility).default(PostVisibility.PUBLIC),
  universityId: z.string().min(1).max(64).optional(),
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
        altText: z.string().max(600).transform(toPlainText).pipe(z.string().max(300)).optional(),
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
  const author = await findUserById(userId);
  if (!author) {
    return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  }

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

  /**
   * Claim the assets BEFORE the post is written.
   *
   * Under Postgres this happened inside the same transaction as the insert, so
   * an asset could not be claimed by a post that then rolled back. Firestore
   * cannot span the two, so the order is chosen for the failure that is
   * recoverable rather than the one that is not:
   *
   *   claim-then-create  -> a crash strands an asset marked attached with no
   *                         post. The image is orphaned; nobody is harmed and
   *                         a sweep can reclaim it.
   *   create-then-claim  -> a crash leaves an UNCLAIMED asset already visible
   *                         in a published post, so a second request could
   *                         attach the same image to a second post. That is
   *                         the race the claim exists to prevent.
   *
   * claimMediaAssets is a transaction over the asset documents themselves, so
   * two concurrent posts cannot both claim the same asset.
   */
  const claim = await claimMediaAssets(requestedIds, userId);
  if (!claim.ok) {
    // Deliberately one message for "no such asset", "not yours" and "already
    // used". Distinguishing them tells a caller which keys exist.
    return NextResponse.json({ error: 'feed.image.errors.invalidKey' }, { status: 400 });
  }
  const orderedAssets = claim.assets;

  /**
   * Tags are upserted first so the post can embed their resolved labels.
   * Blocked tags are dropped, exactly as the SQL version skipped creating the
   * join row for them.
   */
  const tags = await upsertTags(input.tags);

  const postId = newPostId();
  const post = await createPost({
    id: postId,
    authorId: userId,
    body: input.body,
    visibility: input.visibility,
    universityId:
      input.visibility === PostVisibility.UNIVERSITY_ONLY ? author.universityId : null,
    tags,
    media: orderedAssets.map((asset, i) => ({
      id: asset.id,
      storageKey: `db://media/${asset.id}`,
      // The encoder's own values, not the client's claim.
      mimeType: asset.mime,
      width: asset.width,
      height: asset.height,
      altText: input.media[i]?.altText ?? asset.altText,
      position: i,
    })),
  });

  /**
   * Serialised through the SAME function the feed listing uses, so a created
   * post and a listed post are indistinguishable to the client: `tags` and
   * `media` are always arrays, the author always carries a nickname, and
   * shareCount is 0 rather than undefined. A brand-new post has no reposts,
   * hence the literal.
   */
  const university = author.universityId
    ? (await findUniversitiesByIds([author.universityId])).get(author.universityId) ?? null
    : null;

  return NextResponse.json(
    {
      post: serializePost(post, {
        author,
        university,
        viewerId: userId,
        // A brand-new post has no reposts and cannot already be liked.
        shareCount: 0,
        likedByViewer: false,
      }),
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
