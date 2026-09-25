'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UserCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type FollowingState = {
  isFollowing: (nickname: string | null | undefined) => boolean;
  /** Called by the follow button, so every badge on screen updates at once. */
  setFollowing: (nickname: string, following: boolean) => void;
};

const FollowingContext = createContext<FollowingState | null>(null);

/**
 * Who the viewer follows, loaded ONCE per signed-in viewer (GET
 * /api/me/following) and shared by every <FollowingBadge>. Mounted in the
 * root layout; `viewerId` is null for a signed-out visitor, who costs no
 * request. Keyed by lowercased handle - see the endpoint for why.
 */
export function FollowingProvider({ viewerId, children }: { viewerId: string | null; children: ReactNode }) {
  const [followed, setFollowed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    // Not cleared on mount: a child (the profile's follow button) may already
    // have seeded it, and child effects run first. The fetch replaces it whole.
    if (!viewerId) {
      setFollowed(new Set());
      return;
    }
    const controller = new AbortController();
    fetch('/api/me/following', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { nicknames: [] }))
      .then((body: { nicknames?: string[] }) => setFollowed(new Set(body.nicknames ?? [])))
      .catch(() => {});
    return () => controller.abort();
  }, [viewerId]);

  const isFollowing = useCallback(
    (nickname: string | null | undefined) => Boolean(nickname) && followed.has(nickname!.toLowerCase()),
    [followed],
  );
  const setFollowing = useCallback((nickname: string, following: boolean) => {
    const key = nickname.toLowerCase();
    setFollowed((prev) => {
      if (prev.has(key) === following) return prev;
      const next = new Set(prev);
      if (following) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ isFollowing, setFollowing }), [isFollowing, setFollowing]);
  return <FollowingContext.Provider value={value}>{children}</FollowingContext.Provider>;
}

/** Null outside the provider, so a component can use it unconditionally. */
export function useFollowing(): FollowingState | null {
  return useContext(FollowingContext);
}

/**
 * The "Following" pill next to a name. Renders nothing unless the viewer
 * follows that handle - so it is safe to drop next to any @nickname.
 */
export function FollowingBadge({ nickname, className = '' }: { nickname: string | null | undefined; className?: string }) {
  const t = useT();
  const following = useFollowing();
  if (!following?.isFollowing(nickname)) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-px text-2xs font-medium text-accent ${className}`}
    >
      <UserCheck className="h-3 w-3" aria-hidden="true" />
      {t('publicProfile.following')}
    </span>
  );
}
