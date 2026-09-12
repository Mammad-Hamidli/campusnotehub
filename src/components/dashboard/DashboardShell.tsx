'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BookOpen, UserRoundSearch, Wallet } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { mediaUrlFromKey } from '@/lib/media/constants';
import { Sidebar, type DashboardTab } from './Sidebar';
import { VerificationBanner, type VerificationState } from './VerificationBanner';
import { Composer } from './Composer';
import { PostCard, type Post } from './PostCard';
import { GraduationCountdown, TrendingNotes, type TrendingNote } from './RightPanel';

/** 'all' or a university code. The codes are loaded from /api/universities. */
type UniversityFilter = string;

/**
 * BACKEND INTEGRATION — feed
 * --------------------------
 *   GET /api/feed?cursor=<iso>_<id>&limit=20&filter=all|university|following&tag=
 *   -> { posts: Post[], nextCursor: string | null }
 *
 * Keyset pagination, never OFFSET: an offset-paginated feed re-reads and
 * discards every earlier row, so page 50 costs fifty times page 1, and any
 * post created mid-scroll shifts the window and duplicates or skips items.
 * The cursor is `${createdAt.toISOString()}_${id}` and matches the composite
 * index on (createdAt DESC, id DESC).
 *
 * Wire it to an IntersectionObserver on a sentinel below the last card and
 * append pages. Seed data below stands in until then.
 */

type Viewer = {
  id: string;
  nickname: string;
  name: string;
  initials: string;
  university: string;
  verified: boolean;
  /** Drives the mentor onboarding prompt below; see mentorTodo. */
  role: string;
  graduationYear?: number;
  graduationMonth?: number;
};

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
type ApiPost = {
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

type ApiNote = {
  id: string;
  title: string;
  subject: string;
  priceMinor: number;
  ratingAvg: number;
  purchaseCount: number;
  university: { code: string } | null;
};

/** Initials for the avatar fallback, from the public handle only. */
function initialsOf(nickname: string): string {
  return nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

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
function toPost(row: ApiPost): Post {
  const nickname = row.author.nickname;
  return {
    id: row.id,
    authorId: row.author.id,
    author: {
      // The public handle, never fullName - the feed is a shared surface.
      nickname,
      initials: initialsOf(nickname),
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

export function DashboardShell({
  initialTab = 'feed',
  verificationState = 'PENDING',
}: {
  initialTab?: DashboardTab;
  verificationState?: VerificationState;
}) {
  const t = useT();
  const [tab, setTab] = useState<DashboardTab>(initialTab);
  const [filter, setFilter] = useState<UniversityFilter>('all');
  const [posts, setPosts] = useState<Post[]>([]);
  const [trending, setTrending] = useState<TrendingNote[]>([]);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [loading, setLoading] = useState(true);
  const [universityCodes, setUniversityCodes] = useState<string[]>([]);

  /**
   * Filter chips come from the database on every load - no hardcoded list -
   * so a university added or removed in the admin panel shows up here on the
   * next visit without a deploy.
   */
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/universities', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { universities: [] }))
      .then((data: { universities: { code: string }[] }) =>
        setUniversityCodes(data.universities.map((u) => u.code)),
      )
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /**
   * Everything on this screen is loaded from the database.
   *
   * This component used to open with SEED_POSTS - four invented students with
   * invented like and comment counts - a SEED_TRENDING list of four notes that
   * did not exist, and a literal viewer called `mammad_h`. None of it was ever
   * in the database; it was hardcoded here, which is why it appeared identically
   * for every account and survived every cleanup of the data.
   *
   * There is deliberately NO fallback to placeholder content when a fetch
   * returns nothing. An empty feed renders the empty state, because "no posts
   * yet" is the truth about a new deployment and quietly substituting fiction
   * is how the original problem was created.
   */
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const [meRes, feedRes, notesRes] = await Promise.all([
          fetch('/api/me', { signal: controller.signal }),
          fetch('/api/feed?limit=20', { signal: controller.signal }),
          fetch('/api/notes?sort=trending&limit=4', { signal: controller.signal }),
        ]);

        // The JWT passed the edge middleware but the server-side session is
        // gone (revoked, expired, wiped). Rendering an empty dashboard would
        // trap the user: /login bounces straight back here while the cookie
        // lives. /logout clears it and forwards to the sign-in page.
        if (meRes.status === 401) {
          window.location.replace(
            `/logout?next=${encodeURIComponent('/login?next=/dashboard')}`,
          );
          return;
        }

        if (meRes.ok) {
          const { user } = await meRes.json();
          setViewer({
            id: user.id,
            nickname: user.nickname,
            name: user.fullName,
            initials: user.initials,
            university: user.university?.code ?? '—',
            verified: user.isVerified,
            role: user.role,
            graduationYear: user.graduationYear ?? undefined,
            graduationMonth: user.graduationMonth ?? undefined,
          });
        }

        if (feedRes.ok) {
          const { posts: rows } = await feedRes.json();
          setPosts((rows as ApiPost[]).map(toPost));
        }

        if (notesRes.ok) {
          const { notes } = await notesRes.json();
          setTrending(
            notes.map((n: ApiNote) => ({
              id: n.id,
              title: n.title,
              subject: n.subject,
              university: n.university?.code ?? '—',
              priceMinor: n.priceMinor,
              rating: n.ratingAvg,
              purchases: n.purchaseCount,
            })),
          );
        }
      } catch {
        // Aborted on unmount, or the network failed. The empty states below
        // are the correct rendering either way.
      } finally {
        setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, []);

  const visiblePosts = useMemo(
    () => (filter === 'all' ? posts : posts.filter((p) => p.author.university === filter)),
    [posts, filter],
  );

  /**
   * The remaining step for a freshly registered MENTOR.
   *
   * Registering as a mentor creates the ACCOUNT; it does not create the mentor
   * PROFILE, and it cannot - the headline, bio, expertise, experience and rate
   * are reviewed by a moderator before the account appears in the directory.
   * Without this prompt a new mentor lands on a feed with no indication that
   * anything is outstanding, and silently never becomes bookable.
   *
   * Asked only for MENTOR accounts, and only until there is something to show
   * for it: `isMentor` covers an approved profile and `application` covers one
   * already awaiting review, so the card disappears as soon as either is true.
   */
  const [mentorTodo, setMentorTodo] = useState(false);

  useEffect(() => {
    if (viewer?.role !== 'MENTOR') return;
    const controller = new AbortController();

    fetch('/api/mentors/apply', { signal: controller.signal, cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((status) => {
        if (status) setMentorTodo(!status.isMentor && !status.application);
      })
      .catch(() => {
        // A failed status read must not invent an onboarding step.
      });

    return () => controller.abort();
  }, [viewer?.role]);

  /**
   * Posts through the real endpoint instead of pushing an object into local
   * state. The previous version only ever added a card to the array in this
   * browser tab: nothing was written, so the post vanished on reload and never
   * existed for anyone else. The row that comes back is the row the database
   * actually stored, including its id and its zeroed counters.
   */
  const handleNewPost = useCallback(
    async (draft: { body: string; tags: string[]; image?: File }) => {
      /**
       * Two steps, in order: upload the image, then create the post.
       *
       *   1. POST /api/media  -> { storageKey, width, height }
       *   2. POST /api/feed   -> the post, referencing that key
       *
       * The upload comes first so a rejected image (too large, wrong type,
       * corrupt) fails BEFORE a post exists - the alternative is a published
       * post that silently lost its picture, which is worse than an error the
       * user can act on. The bytes never go to /api/feed; only the key does.
       */
      const media: { storageKey: string; altText?: string }[] = [];

      if (draft.image) {
        const form = new FormData();
        form.append('file', draft.image);

        const uploaded = await fetch('/api/media', { method: 'POST', body: form });
        const uploadPayload = await uploaded.json().catch(() => null);

        if (!uploaded.ok) {
          // Thrown with the server's locale key so the composer can render the
          // real reason ("that file is too large") rather than a generic one.
          throw new Error(uploadPayload?.error ?? 'feed.image.errors.uploadFailed');
        }
        media.push({ storageKey: uploadPayload.storageKey });
      }

      const response = await fetch('/api/feed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: draft.body, tags: draft.tags, media }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        /**
         * Thrown, not swallowed.
         *
         * The previous version returned silently on a non-OK response, so the
         * composer cleared the user's text and showed a card for a post the
         * server had refused - a rate-limited or over-length post looked like
         * a success. The message is the server's locale KEY, which the
         * composer renders in the reader's language.
         */
        throw new Error(payload?.error ?? 'errors.generic');
      }

      if (payload?.post) {
        // The row the database actually stored, through the same serialiser
        // the feed listing uses - so `tags` and `media` are arrays and the
        // author carries a nickname. This is what fixes `row.tags.map` on a
        // freshly created post.
        setPosts((prev) => [toPost(payload.post as ApiPost), ...prev]);
        return;
      }

      // Answered 2xx with a shape this client does not know. Re-reading the
      // feed is correct rather than inventing a card.
      const refreshed = await fetch('/api/feed?limit=20');
      if (refreshed.ok) {
        const { posts: rows } = await refreshed.json();
        setPosts((rows as ApiPost[]).map(toPost));
      }
    },
    [],
  );

  /**
   * Nothing renders until the viewer is known.
   *
   * Painting a placeholder identity and swapping it once the real one arrives
   * is precisely how a hardcoded `mammad_h` came to look like a real feature.
   * A brief skeleton is honest; a fake name is not.
   */
  if (loading || !viewer) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-muted">
        <div className="w-full max-w-md space-y-3 px-4" aria-busy="true">
          <div className="h-8 w-40 animate-pulse rounded bg-surface" />
          <div className="h-28 animate-pulse rounded-xl bg-surface" />
          <div className="h-28 animate-pulse rounded-xl bg-surface" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh bg-surface-muted lg:flex-row">
      <Sidebar active={tab} onSelect={setTab} user={viewer} />

      <main id="main" className="min-w-0 flex-1">
        <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <div className="min-w-0 flex-1">
            <VerificationBanner state={verificationState} />

            {mentorTodo && (
              <div className="card animate-rise mb-5 border-accent/30 bg-accent-soft p-4">
                <h2 className="text-sm font-semibold text-fg">
                  {t('dashboard.mentorPrompt.title')}
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">
                  {t('dashboard.mentorPrompt.body')}
                </p>
                <Link href="/mentors/apply" className="btn-primary mt-3.5 px-4 py-2 text-sm">
                  {t('dashboard.mentorPrompt.cta')}
                </Link>
              </div>
            )}

            <header className="mb-5">
              <h1 className="text-xl font-bold tracking-tight text-fg">
                {t('dashboard.greeting', { name: viewer.nickname })}
              </h1>
              <p className="mt-0.5 text-sm text-fg-muted">{t('dashboard.subtitle')}</p>
            </header>

            {tab === 'feed' ? (
              <div className="space-y-4">
                <Composer author={viewer} onPost={handleNewPost} />

                {/* Filter pills. Horizontally scrollable rather than wrapping:
                    with 18 universities seeded this list grows, and a wrapping
                    row would push the first post below the fold on mobile. */}
                <div
                  className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
                  role="group"
                  aria-label={t('notes.filters.university')}
                >
                  {['all', ...universityCodes].map((option) => {
                    const active = option === filter;
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFilter(option)}
                        aria-pressed={active}
                        /*
                          The ACTIVE pill is an accent FILL.
                          It previously read `bg-surface text-accent-fg`, which
                          is two bugs in one: the selected and unselected states
                          shared a background so the choice was invisible, and
                          `--accent-fg` is the colour that sits ON the accent -
                          near-black in dark mode - so on a dark surface it
                          rendered as black text on near-black. Filling with the
                          accent makes accent-fg correct in both themes and
                          makes the selection legible at a glance.
                        */
                        className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                          active
                            ? 'bg-accent text-accent-fg'
                            : 'border border-edge bg-surface text-fg-muted hover:border-edge-strong hover:bg-surface-muted'
                        }`}
                      >
                        {option === 'all' ? t('feed.filters.all') : option}
                      </button>
                    );
                  })}
                </div>

                {visiblePosts.length === 0 ? (
                  <p className="card p-10 text-center text-sm text-fg-muted">{t('feed.empty')}</p>
                ) : (
                  visiblePosts.map((post, i) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      index={i}
                      viewerId={viewer.id}
                      onDeleted={(id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
                    />
                  ))
                )}
              </div>
            ) : (
              <ModulePlaceholder tab={tab} />
            )}
          </div>

          {/* Right rail. Hidden below xl rather than stacked underneath: on a
              tablet these widgets would sit 4+ screens below the composer,
              where nobody scrolls to. The graduation prompt also arrives as a
              notification, so nothing is lost by hiding it here. */}
          <aside className="hidden w-80 shrink-0 space-y-4 xl:block">
            {viewer.graduationYear && viewer.graduationMonth && (
              <GraduationCountdown year={viewer.graduationYear} month={viewer.graduationMonth} />
            )}
            <TrendingNotes notes={trending} />
          </aside>
        </div>
      </main>
    </div>
  );
}

/** The other three tabs are specified in docs/ARCHITECTURE.md but not yet built. */
function ModulePlaceholder({ tab }: { tab: DashboardTab }) {
  const t = useT();

  const config = {
    notes: { icon: BookOpen, titleKey: 'notes.title', bodyKey: 'notes.subtitle' },
    mentors: { icon: UserRoundSearch, titleKey: 'mentors.title', bodyKey: 'mentors.subtitle' },
    wallet: { icon: Wallet, titleKey: 'wallet.title', bodyKey: 'wallet.empty' },
    feed: { icon: BookOpen, titleKey: 'feed.title', bodyKey: 'feed.empty' },
  }[tab];

  const Icon = config.icon;

  return (
    <div className="card animate-rise flex flex-col items-center justify-center px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft">
        <Icon className="h-6 w-6 text-accent" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-lg font-semibold text-fg">{t(config.titleKey)}</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">{t(config.bodyKey)}</p>
    </div>
  );
}
