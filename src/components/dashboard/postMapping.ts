import { mediaUrlFromKey } from '@/lib/media/constants';
import { initialsOf } from '@/components/ui/UserAvatar';
import type { Post } from './PostCard';

/**
 * Feed API rows -> PostCard props. Shared by the dashboard feed (Lent) and
 * the public profile page, so a post renders identically in both.
 */

/**
 * The shape /api/feed returns for one post.
 *
 * This mirrors SerializedPost in src/lib/feed/serialize.ts, which is now the
 * single definition on the server side. Two fields changed shape and both were
 * bugs:
 *
 *   tags - was `{ tag: { slug, label } }[]`, matching the raw Prisma join row.
 *          The server now flattens it, so the client no longer reaches through
 *          a join table it should never have seen. It is ALWAYS an array.
 *   author.nickname - was typed `string | null` and defaulted to 'unknown',
 *          which hid the real problem: the feed query never selected the
 *          column, so every card in the product rendered as "@unknown". It is
 *          selected now and is non-null.
 */
export type ApiPost = {
  id: string;
  body: string;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  likedByViewer: boolean;
  author: {
    id: string;
    nickname: string;
    fullName: string;
    avatarUrl: string | null;
    headline: string | null;
    isVerified: boolean;
    university: { code: string } | null;
  };
  tags: { slug: string; label: string }[];
  media: {
    id: string;
    storageKey: string;
    width: number | null;
    height: number | null;
    altText: string | null;
  }[];
};

/** Relative age, so a row does not need a date formatter to be readable. */
function age(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Maps one API row to the card's props.
 *
 * `row.tags.map(...)` used to throw
 *   TypeError: Cannot read properties of undefined (reading 'map')
 * every time a post was created. The cause was on the SERVER: POST /api/feed
 * returned the created row with only `author` included, while GET included
 * `tags` and `media` - two different contracts from one endpoint family, so a
 * freshly created post had no `tags` key at all.
 *
 * It is fixed there, in src/lib/feed/serialize.ts, which both routes now share.
 * This function is deliberately left WITHOUT optional chaining: `row.tags?.`
 * would silence the symptom while leaving new posts renderable but wrong (no
 * tags, no image, "@unknown" as the author) until a reload. If this ever
 * throws again, the contract has been broken again and that should be loud.
 */
export function toPost(row: ApiPost): Post {
  const nickname = row.author.nickname;
  return {
    id: row.id,
    authorId: row.author.id,
    author: {
      // The public handle, never fullName - the feed is a shared surface.
      nickname,
      initials: initialsOf(nickname),
      avatarUrl: row.author.avatarUrl,
      university: row.author.university?.code ?? '—',
      headline: row.author.headline ?? '',
      verified: row.author.isVerified,
    },
    body: row.body,
    tags: row.tags.map((t) => t.label || t.slug),
    /**
     * The storage key is translated to a URL here, once, rather than in the
     * card. `db://media/<id>` is a LOGICAL locator - the same indirection
     * Note.fileKey uses - so if these move to S3 this single mapping changes
     * and the card keeps rendering a plain src.
     */
    media: row.media.map((m) => ({
      id: m.id,
      url: mediaUrlFromKey(m.storageKey),
      width: m.width,
      height: m.height,
      alt: m.altText,
    })),
    createdAt: age(row.createdAt),
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    shareCount: row.shareCount,
    likedByViewer: row.likedByViewer,
  };
}
