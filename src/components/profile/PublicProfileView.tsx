'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CalendarDays, Clock, GraduationCap, Loader2, Pencil, UserCheck, UserPlus } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { VerifiedBadge } from '@/components/dashboard/VerificationBanner';
import { PostCard, type Post } from '@/components/dashboard/PostCard';
import { toPost, type ApiPost } from '@/components/dashboard/postMapping';
import type { PublicProfile } from '@/lib/profile/public';
import { FollowingBadge, useFollowing } from '@/components/social/Following';

/**
 * Someone's profile: picture (with the verification ring), handle, name when
 * their privacy settings allow it, university, bio, counts, a follow button,
 * and their posts.
 *
 * The profile itself arrives server-rendered (see /u/[nickname]/page.tsx); only
 * the posts are fetched here, through the ordinary feed endpoint narrowed to
 * this author - so post visibility (public / university / followers) is
 * decided by the same audience rules as the dashboard feed.
 */
export function PublicProfileView({
  profile,
  viewerId,
  signedIn,
  viewOnly,
}: {
  profile: PublicProfile;
  viewerId: string | null;
  signedIn: boolean;
  viewOnly: boolean;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [followers, setFollowers] = useState(profile.counts.followers);
  const [posts, setPosts] = useState<Post[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/feed?authorId=${encodeURIComponent(profile.id)}&limit=20`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { posts: [] }))
      .then((body: { posts: ApiPost[] }) => setPosts(body.posts.map(toPost)))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setPosts([]);
      });
    return () => controller.abort();
  }, [profile.id]);

  const joined = new Date(profile.joinedAt).toLocaleDateString(locale, { year: 'numeric', month: 'long' });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <Link
        href={signedIn ? '/dashboard' : '/'}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-fg-muted transition hover:bg-surface-inset hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t(signedIn ? 'publicProfile.backToFeed' : 'publicProfile.backHome')}
      </Link>

      <header className="card mt-3 overflow-hidden">
        {/* A colourful cover strip - the same palette as the verified ring. */}
        <div className="fun-cta h-24 opacity-80 sm:h-28" aria-hidden="true" />

        <div className="px-5 pb-5">
          <div className="-mt-12 flex flex-wrap items-end justify-between gap-3">
            <span className="rounded-full bg-surface p-1">
              <UserAvatar
                nickname={profile.nickname}
                src={profile.avatarUrl}
                verified={profile.isVerified}
                size="xl"
                verifiedLabel={t('profile.verified')}
              />
            </span>

            {profile.viewer.isSelf ? (
              <Link href="/profile" className="btn-secondary">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                {t('profile.edit')}
              </Link>
            ) : (
              <FollowButton
                nickname={profile.nickname}
                initiallyFollowing={profile.viewer.isFollowing}
                initiallyRequested={profile.viewer.requested}
                canFollow={profile.viewer.canFollow}
                signedIn={signedIn}
                viewOnly={viewOnly}
                onFollowers={setFollowers}
              />
            )}
          </div>

          <h1 className="mt-3 flex flex-wrap items-center gap-1.5 text-xl font-bold tracking-tight text-fg">
            @{profile.nickname}
            <VerifiedBadge verified={profile.isVerified} />
            {!profile.viewer.isSelf && <FollowingBadge nickname={profile.nickname} />}
          </h1>
          {profile.fullName && <p className="text-sm font-medium text-fg-muted">{profile.fullName}</p>}
          {profile.headline && <p className="mt-1 text-sm text-fg">{profile.headline}</p>}

          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
            {profile.university && (
              <span className="inline-flex items-center gap-1">
                <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
                {profile.university.name}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              {t('publicProfile.joined', { date: joined })}
            </span>
          </p>

          {profile.bio && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-fg">{profile.bio}</p>}

          <dl className="mt-4 grid grid-cols-4 gap-2 border-t border-edge pt-4 text-center">
            {([
              ['profile.stats.posts', profile.counts.posts],
              ['profile.stats.notes', profile.counts.notes],
              ['profile.stats.followers', followers],
              ['profile.stats.following', profile.counts.following],
            ] as const).map(([labelKey, value]) => (
              <div key={labelKey} className="flex min-w-0 flex-col-reverse">
                <dt className="truncate text-2xs uppercase tracking-wide text-fg-subtle">{t(labelKey)}</dt>
                <dd className="text-lg font-bold tabular-nums text-fg">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <section className="mt-5 space-y-4" aria-labelledby="profile-posts">
        <h2 id="profile-posts" className="text-sm font-semibold text-fg">
          {t('publicProfile.posts')}
        </h2>
        {posts === null ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-fg-subtle" aria-hidden="true" />
          </div>
        ) : posts.length === 0 ? (
          <p className="card p-8 text-center text-sm text-fg-muted">{t('publicProfile.noPosts')}</p>
        ) : (
          posts.map((post, i) => (
            <PostCard
              key={post.id}
              post={post}
              index={i}
              viewerId={viewerId}
              readOnly={!signedIn || viewOnly}
              onDeleted={(id) => setPosts((prev) => prev?.filter((p) => p.id !== id) ?? prev)}
            />
          ))
        )}
      </section>
    </div>
  );
}

/**
 * Follow is a REQUEST: Follow -> Requested (tap again to withdraw) -> Following
 * once the other person accepts. The follower count moves only on unfollow,
 * and is then corrected by the server's number.
 */
function FollowButton({
  nickname,
  initiallyFollowing,
  initiallyRequested,
  canFollow,
  signedIn,
  viewOnly,
  onFollowers,
}: {
  nickname: string;
  initiallyFollowing: boolean;
  initiallyRequested: boolean;
  canFollow: boolean;
  signedIn: boolean;
  viewOnly: boolean;
  onFollowers: (count: number | ((prev: number) => number)) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [following, setFollowingLocal] = useState(initiallyFollowing);
  const [requested, setRequested] = useState(initiallyRequested);
  const [busy, setBusy] = useState(false);
  const shared = useFollowing();

  // Every "Following" badge on screen reads the shared set, so the button
  // writes through to it; the server-rendered value seeds it on first paint.
  const setFollowing = (value: boolean) => {
    setFollowingLocal(value);
    shared?.setFollowing(nickname, value);
  };
  useEffect(() => {
    shared?.setFollowing(nickname, initiallyFollowing);
    // Seed once per profile; later changes go through setFollowing above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nickname]);

  if (!signedIn) {
    return (
      <Link href={`/login?next=${encodeURIComponent(`/u/${nickname}`)}`} className="btn-primary">
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        {t('publicProfile.follow')}
      </Link>
    );
  }

  // Unfinished quick-login profile: following is one of the interactions it
  // unlocks, so point at the way out rather than a dead button.
  if (viewOnly) {
    return (
      <Link href="/onboarding" className="btn-secondary" title={t('onboarding.finishToJoin')}>
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        {t('publicProfile.follow')}
      </Link>
    );
  }

  async function toggle() {
    // Following or Requested: this tap undoes it. Otherwise it asks.
    const asking = !following && !requested;
    const wasFollowing = following;
    setBusy(true);
    if (asking) setRequested(true);
    else {
      setRequested(false);
      setFollowing(false);
      if (wasFollowing) onFollowers((c) => Math.max(0, c - 1));
    }
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(nickname)}/follow`, { method: asking ? 'POST' : 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'errors.generic');
      setFollowing(Boolean(body.following));
      setRequested(Boolean(body.requested));
      if (typeof body.followers === 'number') onFollowers(body.followers);
      if (asking && body.requested) toast.success(t('publicProfile.requestSent', { nickname }));
    } catch (error) {
      setFollowing(wasFollowing);
      setRequested(!asking && !wasFollowing);
      if (wasFollowing) onFollowers((c) => c + 1);
      toast.error(t(error instanceof Error ? error.message : 'errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  const label = following ? 'publicProfile.following' : requested ? 'publicProfile.requested' : 'publicProfile.follow';

  return (
    <button
      type="button"
      onClick={toggle}
      // A frozen account may still UNfollow or withdraw; it just cannot ask anyone new.
      disabled={busy || (!canFollow && !following && !requested)}
      aria-pressed={following || requested}
      title={requested ? t('publicProfile.requestedHint') : undefined}
      className={following || requested ? 'btn-secondary' : 'btn-primary'}
    >
      {following ? (
        <UserCheck className="h-4 w-4" aria-hidden="true" />
      ) : requested ? (
        <Clock className="h-4 w-4" aria-hidden="true" />
      ) : (
        <UserPlus className="h-4 w-4" aria-hidden="true" />
      )}
      {t(label)}
    </button>
  );
}
