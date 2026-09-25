'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { Sidebar, type DashboardTab } from './Sidebar';
import { Composer } from './Composer';
import { PostCard, type Post } from './PostCard';
import { toPost, type ApiPost } from './postMapping';
import { GraduationCountdown, TrendingNotes, type TrendingNote } from './RightPanel';
import { NotesList } from '@/components/notes/NotesList';
import { MentorsList } from '@/components/mentors/MentorsList';
import { can, type Viewer as PermissionViewer } from '@/lib/permissions';

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
  /** With role, the inputs can() needs to decide what the viewer is offered. */
  accountStatus: string;
  verificationStatus: string;
  graduationYear?: number;
  graduationMonth?: number;
  isMentor: boolean;
  /** Quick-login account still on its temporary handle: view-only. */
  profileIncomplete: boolean;
  /** Composer quick-tags; see Composer. */
  hashtagTemplates: string[];
};

type ApiNote = {
  id: string;
  title: string;
  subject: string;
  ratingAvg: number;
  downloadCount: number;
  university: { code: string } | null;
};

export function DashboardShell({ initialTab = 'feed' }: { initialTab?: DashboardTab }) {
  const t = useT();
  const toast = useToast();
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
            accountStatus: user.accountStatus,
            verificationStatus: user.verificationStatus,
            graduationYear: user.graduationYear ?? undefined,
            graduationMonth: user.graduationMonth ?? undefined,
            isMentor: Boolean(user.isMentor),
            profileIncomplete: Boolean(user.profileIncomplete),
            hashtagTemplates: Array.isArray(user.hashtagTemplates) ? user.hashtagTemplates : [],
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
              rating: n.ratingAvg,
              downloads: n.downloadCount,
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
        toast.success(t('feed.posted'));
        return;
      }

      // Answered 2xx with a shape this client does not know. Re-reading the
      // feed is correct rather than inventing a card.
      const refreshed = await fetch('/api/feed?limit=20');
      if (refreshed.ok) {
        const { posts: rows } = await refreshed.json();
        setPosts((rows as ApiPost[]).map(toPost));
      }
      toast.success(t('feed.posted'));
    },
    [t, toast],
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
      <div className="flex min-h-dvh w-full max-w-full items-center justify-center overflow-x-clip bg-surface-muted">
        <div className="w-full max-w-md space-y-3 px-4" aria-busy="true">
          <div className="h-8 w-40 animate-pulse rounded bg-surface" />
          <div className="h-28 animate-pulse rounded-xl bg-surface" />
          <div className="h-28 animate-pulse rounded-xl bg-surface" />
        </div>
      </div>
    );
  }

  /**
   * Same capability table the server enforces, evaluated on the live /api/me
   * record. A UI hint only:
   * POST /api/notes re-checks `notes:share` on every upload.
   */
  const canUploadNotes = can(
    {
      id: viewer.id,
      role: viewer.role as PermissionViewer['role'],
      accountStatus: viewer.accountStatus as PermissionViewer['accountStatus'],
      verificationStatus: viewer.verificationStatus as PermissionViewer['verificationStatus'],
      profileIncomplete: viewer.profileIncomplete,
    },
    'notes:share',
  );

  return (
    /*
      flex-COL below lg. This was `flex lg:flex-row` with no base direction, so
      on mobile the Sidebar's top bar sat BESIDE <main> as a row item, squeezing
      the feed and pushing it past the right edge. overflow-x-clip (not hidden)
      bounds the page without creating a scroll container, which would break
      the sticky mobile bar and desktop rail.
    */
    <div className="flex min-h-dvh w-full max-w-full flex-col overflow-x-clip bg-surface-muted lg:flex-row">
      <Sidebar active={tab} onSelect={setTab} user={viewer} />

      <main id="main" className="w-full min-w-0 max-w-full flex-1">
        <div className="mx-auto flex w-full max-w-6xl gap-6 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
          <div className="min-w-0 flex-1">
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

            {viewer.profileIncomplete && (
              <div className="card animate-rise mb-5 border-warn/40 bg-warn-soft p-4">
                <h2 className="text-sm font-semibold text-fg">{t('onboarding.banner.title')}</h2>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">
                  {t('onboarding.banner.body', { handle: viewer.nickname })}
                </p>
                <Link href="/onboarding" className="btn-primary mt-3.5 px-4 py-2 text-sm">
                  {t('onboarding.banner.cta')}
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
                {/* View-only until the profile is finished - the server refuses
                    the post anyway (permissions.can), so do not offer it. */}
                {!viewer.profileIncomplete && <Composer author={viewer} initialTemplates={viewer.hashtagTemplates} onPost={handleNewPost} />}

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
                      readOnly={viewer.profileIncomplete}
                      onDeleted={(id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
                    />
                  ))
                )}
              </div>
            ) : tab === 'notes' ? (
              // These tabs rendered ModulePlaceholder - a static title card - so
              // the note list, its create button and the mentor directory never
              // appeared on the dashboard. The real modules are used instead.
              <NotesList embedded canUpload={canUploadNotes} />
            ) : tab === 'saved' ? (
              <NotesList embedded source="saved" />
            ) : (
              <MentorsList embedded />
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
