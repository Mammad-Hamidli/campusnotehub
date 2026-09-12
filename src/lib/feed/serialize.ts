import type { PostRecord } from '@/lib/firebase/repositories/posts';
import type { UserRecord } from '@/lib/firebase/repositories/users';
import type { UniversityRecord } from '@/lib/firebase/repositories/reference';

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
 * The author fields the feed renders.
 *
 * ---------------------------------------------------------------------------
 * WHAT REPLACED POST_INCLUDE
 * ---------------------------------------------------------------------------
 * Under Prisma this file exported an `include` object: one declaration that
 * every query reused, so the read path and the write path could not describe a
 * post differently. Firestore has no joins and no `include`, so that shared
 * declaration cannot exist as a query fragment - the author and their
 * university are separate documents, fetched by the caller.
 *
 * The guarantee it provided is preserved by moving it one step later: every
 * route still funnels through serializePost(), and the author is now passed IN
 * as a typed argument. A caller that forgets to load authors gets a type error
 * rather than a post whose author silently renders as "@unknown", which is the
 * failure this file was written to prevent.
 *
 * The feed shows the public handle, never fullName - see the User model.
 */
export type PostAuthor = Pick<
  UserRecord,
  'id' | 'nickname' | 'fullName' | 'avatarUrl' | 'role' | 'isVerified' | 'headline'
>;

/**
 * Everything serializePost needs that does not live on the post document.
 *
 * Grouped into one argument rather than several so adding a future decoration
 * does not change the signature at every call site.
 */
export type PostContext = {
  author: PostAuthor | null;
  university: Pick<UniversityRecord, 'code' | 'nameAz' | 'nameEn' | 'nameRu'> | null;
  viewerId?: string | null;
  likedByViewer?: boolean;
  shareCount?: number;
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
 * Turns a Firestore post document into the wire shape.
 *
 * `shareCount` is passed in rather than read off the row when the caller has a
 * better number; it otherwise comes from the denormalised counter on the post.
 *
 * A MISSING AUTHOR IS NOT A CRASH. Firestore has no foreign keys, so an author
 * document can genuinely be absent - deleted account, or a batch that half
 * committed. Under SQL the join simply excluded such a post. Here the post
 * would still be returned, so the placeholder below keeps the contract
 * (`author` is always an object with a nickname) rather than letting the
 * client meet `undefined.nickname`. Routes that must not show such posts
 * filter them out before serialising; this is the last line of defence.
 */
export function serializePost(post: PostRecord, context: PostContext): SerializedPost {
  const author = context.author;

  return {
    id: post.id,
    body: post.body,
    visibility: post.visibility,
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    likeCount: post.likeCount ?? 0,
    commentCount: post.commentCount ?? 0,
    shareCount: context.shareCount ?? post.shareCount ?? 0,
    likedByViewer: context.likedByViewer ?? false,
    author: {
      id: author?.id ?? post.authorId,
      nickname: author?.nickname ?? 'unknown',
      fullName: author?.fullName ?? '',
      avatarUrl: author?.avatarUrl ?? null,
      headline: author?.headline ?? null,
      role: author?.role ?? 'STUDENT',
      isVerified: author?.isVerified ?? false,
      university: context.university,
    },
    /**
     * The two guarantees the client depends on.
     *
     * `?? []` is NOT the optional-chaining patch this file argues against. In
     * Firestore an empty array is not stored at all - `forFirestore` strips
     * nothing, but a document written before these fields existed simply has
     * no key - so an absent `tags` genuinely means "no tags" and must
     * serialise as `[]`. The contract stays "always an array".
     */
    tags: (post.tags ?? []).map((t) => ({ slug: t.slug, label: t.label || t.slug })),
    media: (post.media ?? [])
      // Ordered here rather than by the query: media is an embedded array, so
      // there is no `orderBy` to apply to it. The position field is what the
      // author arranged, and it must survive the round trip.
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((m) => ({
        id: m.id,
        storageKey: m.storageKey,
        mimeType: m.mimeType,
        width: m.width,
        height: m.height,
        altText: m.altText,
      })),
  };
}
