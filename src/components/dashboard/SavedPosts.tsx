'use client';

import { useEffect, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { PostCard, type Post } from './PostCard';
import { toPost, type ApiPost } from './postMapping';
import { useT } from '@/lib/i18n/LocaleProvider';

export function SavedPosts({ viewerId, readOnly }: { viewerId: string; readOnly: boolean }) {
  const t = useT();
  const [posts, setPosts] = useState<Post[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/feed/saved', { signal: controller.signal, cache: 'no-store' })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('saved posts')))
      .then((body: { posts: ApiPost[] }) => setPosts(body.posts.map(toPost)))
      .catch(() => { if (!controller.signal.aborted) setPosts([]); });
    return () => controller.abort();
  }, []);

  return (
    <section className="space-y-3" aria-labelledby="saved-posts-title">
      <h2 id="saved-posts-title" className="text-lg font-semibold text-fg">{t('feed.saved.title')}</h2>
      {posts === null ? (
        <div className="card h-24 animate-pulse" aria-busy="true" />
      ) : posts.length ? (
        posts.map((post, index) => <PostCard key={post.id} post={post} index={index} viewerId={viewerId} readOnly={readOnly} onDeleted={(id) => setPosts((previous) => previous?.filter((item) => item.id !== id) ?? [])} onSavedChange={(id, saved) => { if (!saved) setPosts((previous) => previous?.filter((item) => item.id !== id) ?? []); }} />)
      ) : (
        <p className="card flex items-center gap-2 p-5 text-sm text-fg-muted"><Bookmark className="h-4 w-4" aria-hidden="true" />{t('feed.saved.empty')}</p>
      )}
    </section>
  );
}
