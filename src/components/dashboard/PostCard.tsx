'use client';

import { useState } from 'react';
import { Heart, MessageCircle, MoreHorizontal, Repeat2, Share2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { VerifiedBadge } from './VerificationBanner';

export type Post = {
  id: string;
  author: {
    /**
     * PUBLIC HANDLE, not the legal name.
     *
     * The feed, note listings and mentor reviews all render this. The name on
     * someone's ID document exists in the database for verification and is
     * gated behind their `showRealName` privacy setting - it never reaches a
     * shared surface like this one.
     */
    nickname: string;
    initials: string;
    university: string;
    headline: string;
    verified: boolean;
  };
  body: string;
  tags: string[];
  createdAt: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  likedByViewer: boolean;
};

export function PostCard({ post, index = 0 }: { post: Post; index?: number }) {
  const t = useT();
  const [liked, setLiked] = useState(post.likedByViewer);
  const [likeCount, setLikeCount] = useState(post.likeCount);

  /**
   * BACKEND INTEGRATION
   * -------------------
   *   POST   /api/feed/:postId/like    -> 204
   *   DELETE /api/feed/:postId/like    -> 204
   *
   * Both are idempotent: the like table uses a composite (postId, userId)
   * primary key, so a double-tap or a retried request cannot double-count.
   *
   * The optimistic update below flips state before the request and rolls back
   * on failure. Waiting for the round trip makes the button feel broken on
   * campus wifi, and a like is cheap enough to be wrong for 300ms.
   */
  async function toggleLike() {
    const next = !liked;
    setLiked(next);
    setLikeCount((c) => c + (next ? 1 : -1));

    // const res = await fetch(`/api/feed/${post.id}/like`, {
    //   method: next ? 'POST' : 'DELETE',
    // });
    // if (!res.ok) {                      // roll back
    //   setLiked(!next);
    //   setLikeCount((c) => c + (next ? -1 : 1));
    // }
  }

  return (
    <article
      style={{ animationDelay: `${Math.min(index, 6) * 50}ms` }}
      className="card animate-rise p-4 transition-shadow hover:shadow-raised"
    >
      <header className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full
 bg-surface-inset text-xs font-bold text-accent-fg"
          aria-hidden="true"
        >
          {post.author.initials}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="truncate text-sm font-medium text-fg">@{post.author.nickname}</span>
            <VerifiedBadge verified={post.author.verified} />
            <span
              className="rounded-md bg-surface-inset px-1.5 py-0.5 text-2xs font-semibold text-fg-muted"
            >
              {post.author.university}
            </span>
            <span className="text-xs text-fg-subtle" aria-hidden="true">
              ·
            </span>
            <time className="text-xs text-fg-subtle">{post.createdAt}</time>
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-muted">{post.author.headline}</p>
        </div>

        <button
          type="button"
          aria-label={t('common.showMore')}
          className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </header>

      <p className="mt-3 whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-fg">
        {post.body}
      </p>

      {post.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {post.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent
 transition hover:bg-accent-soft"
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      <footer className="mt-3.5 flex items-center gap-1 border-t border-edge pt-2.5">
        <ActionButton
          icon={Heart}
          label={t('feed.like')}
          count={likeCount}
          active={liked}
          activeClass="text-rose-600"
          iconFill={liked}
          onClick={toggleLike}
        />
        <ActionButton
          icon={MessageCircle}
          label={t('feed.comment')}
          count={post.commentCount}
          activeClass="text-accent"
        />
        <ActionButton
          icon={Repeat2}
          label={t('feed.share')}
          count={post.shareCount}
          activeClass="text-verified"
        />
        <div className="flex-1" />
        <button
          type="button"
          aria-label={t('feed.share')}
          className="rounded-lg p-2 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
        >
          <Share2 className="h-4 w-4" />
        </button>
      </footer>
    </article>
  );
}

function ActionButton({
  icon: Icon,
  label,
  count,
  active = false,
  activeClass,
  iconFill = false,
  onClick,
}: {
  icon: typeof Heart;
  label: string;
  count: number;
  active?: boolean;
  activeClass: string;
  iconFill?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      // aria-label carries the count so a screen reader announces
      // "Like, 24" rather than an unlabelled icon next to a bare number.
      aria-label={`${label}, ${count}`}
      className={`group flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm transition
                  hover:bg-surface-inset ${active ? activeClass : 'text-fg-muted'}`}
    >
      <Icon
        className={`h-[1.05rem] w-[1.05rem] transition-transform group-active:scale-90 ${
          iconFill ? 'fill-current' : ''
        }`}
        aria-hidden="true"
      />
      <span className="tabular text-xs font-medium">{count}</span>
    </button>
  );
}
