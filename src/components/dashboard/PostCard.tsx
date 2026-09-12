'use client';

import { useState } from 'react';
import { Flag, Heart, Link2, MessageCircle, MoreHorizontal, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { VerifiedBadge } from './VerificationBanner';
import { CommentThread } from './CommentThread';

export type Post = {
  id: string;
  /** The author's user id. Decides which actions the "..." menu offers. */
  authorId: string;
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
  /** Already resolved to a servable URL by the feed mapper. */
  media: { id: string; url: string; width: number | null; height: number | null; alt: string | null }[];
  createdAt: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  likedByViewer: boolean;
};

export function PostCard({
  post,
  index = 0,
  viewerId = null,
  onDeleted,
}: {
  post: Post;
  index?: number;
  viewerId?: string | null;
  onDeleted?: (postId: string) => void;
}) {
  const t = useT();
  const [liked, setLiked] = useState(post.likedByViewer);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  const [showComments, setShowComments] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isOwn = Boolean(viewerId) && post.authorId === viewerId;

  /**
   * Likes.
   *
   *   POST   /api/feed/:postId/like
   *   DELETE /api/feed/:postId/like
   *
   * Both are idempotent: the like table uses a composite (postId, userId)
   * primary key, so a double-tap or a retried request cannot double-count.
   *
   * The optimistic update flips state before the request and rolls back on
   * failure. Waiting for the round trip makes the button feel broken on campus
   * wifi, and a like is cheap enough to be wrong for 300ms.
   */
  async function toggleLike() {
    const next = !liked;
    setLiked(next);
    setLikeCount((c) => c + (next ? 1 : -1));

    try {
      const response = await fetch(`/api/feed/${post.id}/like`, {
        method: next ? 'POST' : 'DELETE',
      });
      if (!response.ok) {
        setLiked(!next);
        setLikeCount((c) => c + (next ? -1 : 1));
        return;
      }
      // Trust the server's total over the local guess: two tabs, or a like
      // that arrived while this one was in flight, would otherwise drift.
      const payload = await response.json().catch(() => null);
      if (payload && typeof payload.likeCount === 'number') {
        setLikeCount(payload.likeCount);
        setLiked(Boolean(payload.liked));
      }
    } catch {
      setLiked(!next);
      setLikeCount((c) => c + (next ? -1 : 1));
    }
  }

  /** DELETE /api/feed/:postId - own posts only; the server re-checks. */
  async function deletePost() {
    if (!window.confirm(t('feed.menu.deleteConfirm'))) return;
    setDeleting(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/feed/${post.id}`, { method: 'DELETE' });
      if (!response.ok) {
        setNotice(t('feed.menu.deleteFailed'));
        return;
      }
      onDeleted?.(post.id);
    } catch {
      setNotice(t('feed.menu.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  async function reportPost() {
    setNotice(null);
    try {
      const response = await fetch(`/api/feed/${post.id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      setNotice(t(response.ok ? 'feed.menu.reported' : 'feed.menu.reportFailed'));
    } catch {
      setNotice(t('feed.menu.reportFailed'));
    }
  }

  async function copyLink() {
    const url = `${window.location.origin}/dashboard#post-${post.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice(t('feed.menu.linkCopied'));
    } catch {
      // Clipboard access refused (insecure context, permissions): show the
      // link so it can still be copied by hand.
      setNotice(url);
    }
  }

  return (
    <article
      id={`post-${post.id}`}
      style={{ animationDelay: `${Math.min(index, 6) * 50}ms` }}
      className={`card animate-rise p-4 transition-shadow hover:shadow-raised ${deleting ? 'opacity-60' : ''}`}
    >
      <header className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full
 bg-surface-inset text-xs font-bold text-accent"
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

        {/* Own post: copy link + delete. Someone else's: copy link + report.
            There is deliberately no edit action. */}
        <Menu
          label={t('feed.menu.label')}
          width="w-48"
          trigger={({ open, toggle, id }) => (
            <button
              type="button"
              data-menu-trigger
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={id}
              aria-label={t('feed.menu.label')}
              onClick={toggle}
              disabled={deleting}
              className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <MenuItem
                icon={<Link2 className="h-4 w-4" />}
                onSelect={() => {
                  close();
                  void copyLink();
                }}
              >
                {t('feed.menu.copyLink')}
              </MenuItem>
              {isOwn ? (
                <MenuItem
                  tone="danger"
                  icon={<Trash2 className="h-4 w-4" />}
                  onSelect={() => {
                    close();
                    void deletePost();
                  }}
                >
                  {t('feed.menu.delete')}
                </MenuItem>
              ) : (
                <MenuItem
                  tone="danger"
                  icon={<Flag className="h-4 w-4" />}
                  onSelect={() => {
                    close();
                    void reportPost();
                  }}
                >
                  {t('feed.menu.report')}
                </MenuItem>
              )}
            </>
          )}
        </Menu>
      </header>

      <p className="mt-3 whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-fg">
        {post.body}
      </p>

      {/*
        Images.

        `aspect-ratio` is set from the stored dimensions so the browser
        reserves the right box BEFORE the bytes arrive. Without it every image
        loads at zero height and then shoves the rest of the feed down - the
        layout shift that makes a timeline unusable while scrolling.
      */}
      {post.media.length > 0 && (
        <div
          className={`mt-3 grid gap-1.5 ${post.media.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          {post.media.map((image) => (
            <a
              key={image.id}
              href={image.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-xl border border-edge bg-surface-inset"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- next/image
                  would proxy through the optimiser, which needs a configured
                  loader and buys nothing here: these are already re-encoded,
                  bounded WebP served with an immutable cache header. */}
              <img
                src={image.url}
                alt={image.alt ?? ''}
                width={image.width ?? undefined}
                height={image.height ?? undefined}
                loading="lazy"
                decoding="async"
                className="h-auto w-full object-cover"
                style={
                  image.width && image.height
                    ? { aspectRatio: `${image.width} / ${image.height}` }
                    : undefined
                }
              />
            </a>
          ))}
        </div>
      )}

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

      {notice && (
        <p role="status" className="mt-2 break-all text-xs text-fg-muted">
          {notice}
        </p>
      )}

      <footer className="mt-3.5 flex items-center gap-1 border-t border-edge pt-2.5">
        <ActionButton
          icon={Heart}
          label={t('feed.like')}
          count={likeCount}
          active={liked}
          activeClass="text-danger"
          iconFill={liked}
          onClick={toggleLike}
        />
        <ActionButton
          icon={MessageCircle}
          label={showComments ? t('feed.hideComments') : t('feed.showComments')}
          count={commentCount}
          active={showComments}
          activeClass="text-accent"
          onClick={() => setShowComments((v) => !v)}
        />
      </footer>

      {/* Mounted only when expanded, so the thread's fetch happens on demand
          rather than twenty times per feed page. */}
      {showComments && <CommentThread postId={post.id} onCountChange={setCommentCount} />}
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
