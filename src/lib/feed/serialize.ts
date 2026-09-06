import { Prisma } from '@prisma/client';

/**
 * The one definition of what a post looks like over the wire.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FILE EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * The dashboard crashed with
 *
 *   TypeError: Cannot read properties of undefined (reading 'map')
 *   at toPost - tags: row.tags.map(...)
 *
 * whenever a post was created, and only then. The cause was not the client.
 * GET /api/feed included `tags` and `media` in its query; POST /api/feed
 * returned `tx.post.create({ include: { author: ... } })` - author and nothing
 * else. So the same endpoint family described a post two different ways, and
 * the freshly created one simply had no `tags` KEY at all.
 *
 * `row.tags?.map(...)` would have silenced the crash and kept the real defect:
 * a post that genuinely has no tags must serialise as `tags: []`, because an
 * empty list and an absent field mean different things and only one of them is
 * true here. Optional chaining would also have left `media` and the author's
 * `nickname` quietly missing, so a new post would render as "@unknown" with no
 * image until the page was reloaded - which is precisely what it did.
 *
 * The fix is a single shared SELECT and a single serialiser that every route
 * returning a post must use. Adding a field to the client contract now means
 * adding it here once, where both the read and the write path pick it up.
 */

/**
 * The include used by every query that returns a post.
 *
 * `satisfies` rather than a bare object literal so Prisma type-checks the
 * relation names at compile time: a typo here would otherwise surface as a
 * runtime "unknown field" from the database.
 */
export const POST_INCLUDE = {
  author: {
    select: {
      id: true,
      // nickname is REQUIRED by the client and was missing from the GET
      // select, which is why every card rendered as "@unknown". The feed shows
      // the public handle, never fullName - see the User model.
      nickname: true,
      fullName: true,
      avatarUrl: true,
      role: true,
      isVerified: true,
      headline: true,
      university: { select: { code: true, nameAz: true, nameEn: true, nameRu: true } },
    },
  },
  media: { orderBy: { position: 'asc' } },
  tags: { include: { tag: { select: { slug: true, label: true } } } },
} satisfies Prisma.PostInclude;

type PostWithRelations = Prisma.PostGetPayload<{ include: typeof POST_INCLUDE }> & {
  /** Present only when the viewer is signed in; see the feed query. */
  likes?: { userId: string }[];
};

/** The response contract. Every field is always present. */
export type SerializedPost = {
  id: string;
  body: string;
  visibility: string;
  createdAt: string;
  editedAt: string | null;
  likeCount: number;
  commentCount: number;
  /**
   * Reposts of this post.
   *
   * The client called this `shareCount` and read it off the row, but there has
   * never been such a column - it rendered `undefined` in the counter. The
   * schema models sharing as a self-relation ("Repost"), so the honest number
   * is a count of those, and it is computed rather than invented.
   */
  shareCount: number;
  likedByViewer: boolean;
  author: {
    id: string;
    nickname: string;
    fullName: string;
    avatarUrl: string | null;
    headline: string | null;
    role: string;
    isVerified: boolean;
    university: { code: string; nameAz: string; nameEn: string; nameRu: string } | null;
  };
  /** ALWAYS an array. Empty when the post has no tags. Never undefined. */
  tags: { slug: string; label: string }[];
  /** ALWAYS an array. Empty for a text-only post. Never undefined. */
  media: { id: string; storageKey: string; mimeType: string; width: number | null; height: number | null; altText: string | null }[];
};

/**
 * Turns a Prisma row into the wire shape.
 *
 * `shareCount` is passed in rather than read off the row because counting
 * reposts is a separate aggregate; the caller decides whether that count is
 * worth a query. It defaults to 0, which is the correct value for a post that
 * was created moments ago and is what the create path passes.
 */
export function serializePost(
  post: PostWithRelations,
  options: { viewerId?: string | null; shareCount?: number } = {},
): SerializedPost {
  return {
    id: post.id,
    body: post.body,
    visibility: post.visibility,
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    shareCount: options.shareCount ?? 0,
    // `likes` is only selected for a signed-in viewer, so its absence means
    // "nobody is signed in", not "not liked" - both serialise to false, but
    // the distinction is why this is not written as post.likes.length > 0.
    likedByViewer: Array.isArray(post.likes) ? post.likes.length > 0 : false,
    author: {
      id: post.author.id,
      nickname: post.author.nickname,
      fullName: post.author.fullName,
      avatarUrl: post.author.avatarUrl,
      headline: post.author.headline,
      role: post.author.role,
      isVerified: post.author.isVerified,
      university: post.author.university,
    },
    // The two guarantees the client depends on. `?? []` here is NOT the
    // optional-chaining patch this file argues against: the relations are
    // always included by POST_INCLUDE, so these coalesce only against a
    // hand-built row in a test, and the contract stays "always an array".
    tags: (post.tags ?? []).map((t) => ({ slug: t.tag.slug, label: t.tag.label || t.tag.slug })),
    media: (post.media ?? []).map((m) => ({
      id: m.id,
      storageKey: m.storageKey,
      mimeType: m.mimeType,
      width: m.width,
      height: m.height,
      altText: m.altText,
    })),
  };
}
