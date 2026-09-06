'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { VerifiedBadge } from './VerificationBanner';

/**
 * The comment thread under a post.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS COMPONENT IS NEW
 * ---------------------------------------------------------------------------
 * "Comments cannot be written after posting" had a blunt cause: there was no
 * comment UI and no comment endpoint anywhere in the codebase. The card
 * rendered a comment button with a count and the button had no click handler
 * at all, so nothing was broken in the usual sense - the feature had simply
 * never been built. This is the client half; the server half is
 * /api/feed/[postId]/comments.
 *
 * Comments load LAZILY, on first expand, rather than with the feed. A feed page
 * is twenty posts, and eagerly fetching every thread would be twenty extra
 * requests for content most readers never open.
 */

const MAX_COMMENT = 1000;

type ApiComment = {
  id: string;
  body: string;
  isDeleted: boolean;
  createdAt: string;
  parentId: string | null;
  author: {
    id: string;
    nickname: string;
    avatarUrl: string | null;
    isVerified: boolean;
    headline: string | null;
  };
};

function initialsOf(nickname: string): string {
  return nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

function age(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function CommentThread({
  postId,
  onCountChange,
}: {
  postId: string;
  /** Lifts the new count so the card's counter stays in step. */
  onCountChange?: (count: number) => void;
}) {
  const t = useT();
  const [comments, setComments] = useState<ApiComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/feed/${postId}/comments?limit=50`, { signal });
        if (!response.ok) {
          setError(t('feed.commentFailed'));
          return;
        }
        const data = await response.json();
        setComments(data.comments ?? []);
      } catch (cause) {
        // An abort is an unmount, not a failure, and must not paint an error
        // over a component that is going away.
        if ((cause as Error)?.name === 'AbortError') return;
        setError(t('feed.commentFailed'));
      } finally {
        setLoading(false);
      }
    },
    [postId, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text || posting) return;

    setPosting(true);
    setError(null);

    try {
      const response = await fetch(`/api/feed/${postId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // The server answers with a locale KEY, so the message is shown in the
        // reader's own language rather than in whatever the API happened to
        // hardcode. Falls back to the generic string for an unknown key.
        setError(t(payload?.error ?? 'feed.commentFailed'));
        return;
      }

      /**
       * Appended from the SERVER's row, not from the local draft.
       *
       * Rendering an optimistic stub would mean inventing an id, a timestamp
       * and an author - and the id in particular would be wrong, which breaks
       * the React key and any later reply targeting it. Comments are cheap and
       * the round trip is short; correctness is worth the 200ms here in a way
       * it is not for a like.
       */
      if (payload?.comment) {
        setComments((prev) => [...prev, payload.comment as ApiComment]);
        onCountChange?.(payload.commentCount ?? comments.length + 1);
      }
      setBody('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
    } catch {
      setError(t('feed.commentFailed'));
    } finally {
      setPosting(false);
    }
  }

  const remaining = MAX_COMMENT - body.length;
  const canPost = body.trim().length > 0 && remaining >= 0 && !posting;

  return (
    <section className="mt-3 border-t border-edge pt-3" aria-label={t('feed.comments')}>
      {loading ? (
        <p className="py-3 text-center text-xs text-fg-muted" aria-busy="true">
          {t('feed.commentLoading')}
        </p>
      ) : comments.length === 0 ? (
        <p className="py-3 text-center text-xs text-fg-muted">{t('feed.commentEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="flex gap-2.5">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-inset text-2xs font-bold text-accent"
                aria-hidden="true"
              >
                {initialsOf(comment.author.nickname)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-1.5">
                  <span className="truncate text-xs font-medium text-fg">
                    @{comment.author.nickname}
                  </span>
                  <VerifiedBadge verified={comment.author.isVerified} />
                  <time className="text-2xs text-fg-subtle">{age(comment.createdAt)}</time>
                </div>
                <p
                  className={`mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed ${
                    comment.isDeleted ? 'italic text-fg-subtle' : 'text-fg'
                  }`}
                >
                  {comment.isDeleted ? t('feed.commentDeleted') : comment.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="mt-3 flex items-end gap-2">
        <label htmlFor={`comment-${postId}`} className="sr-only">
          {t('feed.commentPlaceholder')}
        </label>
        <textarea
          id={`comment-${postId}`}
          ref={inputRef}
          value={body}
          rows={1}
          maxLength={MAX_COMMENT}
          onChange={(e) => {
            setBody(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line. A comment box is a
            // chat-shaped input, unlike the multi-line composer above it.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit(e as unknown as React.FormEvent);
            }
          }}
          placeholder={t('feed.commentPlaceholder')}
          className="input max-h-36 min-h-[2.25rem] resize-none py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={!canPost}
          aria-label={t('feed.commentSubmit')}
          className="btn-primary h-9 shrink-0 px-3"
        >
          {posting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </form>

      {error && (
        <p className="mt-1.5 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
