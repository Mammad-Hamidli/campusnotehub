'use client';

import { useEffect, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { PostCard, type Post } from './PostCard';
import { toPost, type ApiPost } from './postMapping';
import { useT } from '@/lib/i18n/LocaleProvider';

export function SavedPosts({ viewerId, readOnly }: { viewerId: string; readOnly: boolean }) {
  const t = useT();
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    fetch('/api/feed/saved', {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { posts?: ApiPost[]; error?: string } | null;
        if (!response.ok) {
          throw new Error(`GET /api/feed/saved returned ${response.status}${body?.error ? ` (${body.error})` : ''}`);
        }
        if (!body || !Array.isArray(body.posts)) {
          throw new Error('GET /api/feed/saved returned an invalid posts payload');
        }
        return body.posts.map(toPost);
      })
      .then(setPosts)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error('[SavedPosts] Could not load /api/feed/saved', error);
        setPosts([]);
        setLoadFailed(true);
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <section className="space-y-3" aria-labelledby="saved-posts-title">
      <h2 id="saved-posts-title" className="text-lg font-semibold text-fg">{t('feed.saved.title')}</h2>
      {posts === null ? (
        <div className="card h-24 animate-pulse" aria-busy="true" />
      ) : loadFailed ? (
        <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-danger">
          <span>{t('errors.generic')}</span>
          <button type="button" onClick={() => { setPosts(null); setReloadKey((value) => value + 1); }} className="btn-secondary px-3 py-1.5 text-xs">{t('common.retry')}</button>
        </div>
      ) : posts.length ? (
        posts.map((post, index) => <PostCard key={post.id} post={post} index={index} viewerId={viewerId} readOnly={readOnly} onDeleted={(id) => setPosts((previous) => previous?.filter((item) => item.id !== id) ?? [])} onSavedChange={(id, saved) => { if (!saved) setPosts((previous) => previous?.filter((item) => item.id !== id) ?? []); }} />)
      ) : (
        <p className="card flex items-center gap-2 p-5 text-sm text-fg-muted"><Bookmark className="h-4 w-4" aria-hidden="true" />{t('feed.saved.empty')}</p>
      )}
    </section>
  );
}
