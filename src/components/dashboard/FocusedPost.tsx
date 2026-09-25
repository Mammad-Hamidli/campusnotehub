'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PostCard, type Post } from './PostCard';
import { toPost, type ApiPost } from './postMapping';

type State =
  | { status: 'loading' }
  | { status: 'ready'; post: Post }
  | { status: 'missing' }
  | { status: 'error' };

/**
 * The single-post view behind /dashboard?post=<id> - where a like or comment
 * notification, or a copied post link, lands.
 *
 * The post is fetched by id (GET /api/feed/:postId) rather than looked up in
 * the feed already on screen: the feed holds one page of the newest posts,
 * and the post a notification is about is usually older than that.
 *
 * The parent keys this component by post id, so moving between two posts
 * starts from a clean loading state instead of flashing the previous one.
 */
export function FocusedPost({
  postId,
  viewerId,
  readOnly,
  onClose,
  onDeleted,
}: {
  postId: string;
  viewerId: string;
  readOnly: boolean;
  onClose: () => void;
  onDeleted: (postId: string) => void;
}) {
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/feed/${encodeURIComponent(postId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        // 404 covers "deleted" and "not visible to you" alike - see the route.
        if (response.status === 404) return setState({ status: 'missing' });
        if (!response.ok) return setState({ status: 'error' });
        const { post } = (await response.json()) as { post: ApiPost };
        setState({ status: 'ready', post: toPost(post) });
      })
      .catch((cause) => {
        if ((cause as Error)?.name !== 'AbortError') setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [postId, attempt]);

  return (
    <div className="space-y-4">
      <button type="button" onClick={onClose} className="btn-ghost h-8 px-2.5 text-sm">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('feed.focus.back')}
      </button>

      {state.status === 'loading' ? (
        <div className="card h-48 animate-pulse" aria-busy="true" />
      ) : state.status === 'ready' ? (
        <PostCard
          post={state.post}
          viewerId={viewerId}
          readOnly={readOnly}
          defaultShowComments
          onDeleted={onDeleted}
        />
      ) : (
        <div className="card p-10 text-center">
          <p className="text-sm text-fg-muted">
            {t(state.status === 'missing' ? 'feed.focus.missing' : 'errors.generic')}
          </p>
          {state.status === 'error' && (
            <button
              type="button"
              onClick={() => {
                setState({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
              className="btn-secondary mt-3 px-3 py-1.5 text-sm"
            >
              {t('common.retry')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
