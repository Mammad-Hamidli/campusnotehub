'use client';

import { useMemo, useState } from 'react';
import { BookOpen, UserRoundSearch, Wallet } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { Sidebar, type DashboardTab } from './Sidebar';
import { VerificationBanner, type VerificationState } from './VerificationBanner';
import { Composer } from './Composer';
import { PostCard, type Post } from './PostCard';
import { GraduationCountdown, TrendingNotes, type TrendingNote } from './RightPanel';

const UNIVERSITY_FILTERS = ['all', 'UNEC', 'ADA', 'BDU', 'ADNSU'] as const;
type UniversityFilter = (typeof UNIVERSITY_FILTERS)[number];

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
const SEED_POSTS: Post[] = [
  {
    id: '1',
    author: {
      nickname: 'aysel_m',
      initials: 'AM',
      university: 'ADA',
      headline: 'Computer Science, 3rd year',
      verified: true,
    },
    body: 'Sabahkı Diskret Riyaziyyat imtahanı 3-cü korpusa keçirilib, 09:00. Dekanlıqdan rəsmi elan gəlib — auditoriya 314 deyil, 208.',
    tags: ['ExamAlert'],
    createdAt: '12m',
    likeCount: 48,
    commentCount: 12,
    shareCount: 7,
    likedByViewer: false,
  },
  {
    id: '2',
    author: {
      nickname: 'rashad_h',
      initials: 'RH',
      university: 'UNEC',
      headline: 'Finance, alumni 2023 · Analyst at PASHA Bank',
      verified: true,
    },
    body: 'Bu həftə 3 nəfər üçün pulsuz mentorluq slotu açdım. CV və müsahibə hazırlığı üzrə danışa bilərik. PocketMentor profilimdən yazın.',
    tags: ['Career', 'Internship'],
    createdAt: '1h',
    likeCount: 126,
    commentCount: 34,
    shareCount: 21,
    likedByViewer: true,
  },
  {
    id: '3',
    author: {
      nickname: 'nigar_q',
      initials: 'NQ',
      university: 'BDU',
      headline: 'Physics, 2nd year',
      verified: true,
    },
    body: 'Termodinamika I üzrə bütün semestr konspektimi UniNotes-a yüklədim — 64 səhifə, əl yazısı skan edilmiş və oxunaqlıdır. Kolokvium üçün kifayət edir.',
    tags: ['Notes'],
    createdAt: '3h',
    likeCount: 89,
    commentCount: 15,
    shareCount: 31,
    likedByViewer: false,
  },
  {
    id: '4',
    author: {
      nickname: 'elvin_s',
      initials: 'ES',
      university: 'ADNSU',
      headline: 'Petroleum Engineering, 4th year',
      verified: false,
    },
    body: 'SOCAR-ın yay təcrübə proqramına müraciət son tarixi 15 mart. Keçən il keçmiş biri varsa, seçim mərhələləri haqqında danışa bilərmi?',
    tags: ['Internship', 'Deadline'],
    createdAt: '5h',
    likeCount: 54,
    commentCount: 28,
    shareCount: 9,
    likedByViewer: false,
  },
];

const SEED_TRENDING: TrendingNote[] = [
  { id: 'n1', title: 'Diskret riyaziyyat — final konspekt', subject: 'Mathematics', university: 'ADA', priceMinor: 500, rating: 4.8, purchases: 34 },
  { id: 'n2', title: 'Mikroiqtisadiyyat — tam kurs', subject: 'Economics', university: 'UNEC', priceMinor: 750, rating: 4.6, purchases: 27 },
  { id: 'n3', title: 'Termodinamika I', subject: 'Physics', university: 'BDU', priceMinor: 0, rating: 4.9, purchases: 22 },
  { id: 'n4', title: 'Mülki hüquq — seminar qeydləri', subject: 'Law', university: 'BDU', priceMinor: 400, rating: 4.4, purchases: 18 },
];

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
  const [posts, setPosts] = useState<Post[]>(SEED_POSTS);

  /**
   * BACKEND INTEGRATION — viewer.
   * Replace with the session payload from GET /api/auth/me, or better, pass it
   * from the server component so the shell renders with the real identity on
   * first paint instead of flashing a placeholder.
   */
  const viewer = {
    // Public handle. The Sidebar and every post render THIS, never fullName.
    nickname: 'mammad_h',
    name: 'Mammad Hamidli',
    initials: 'MH',
    university: 'ADA',
    verified: verificationState === 'VERIFIED',
    graduationYear: 2026,
    graduationMonth: 5,
  };

  const visiblePosts = useMemo(
    () => (filter === 'all' ? posts : posts.filter((p) => p.author.university === filter)),
    [posts, filter],
  );

  function handleNewPost(draft: { body: string; tags: string[] }) {
    setPosts((prev) => [
      {
        id: crypto.randomUUID(),
        author: {
          nickname: viewer.nickname,
          initials: viewer.initials,
          university: viewer.university,
          headline: 'Computer Science',
          verified: viewer.verified,
        },
        body: draft.body,
        tags: draft.tags,
        createdAt: 'now',
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        likedByViewer: false,
      },
      ...prev,
    ]);
  }

  return (
    <div className="flex min-h-dvh bg-surface-muted lg:flex-row">
      <Sidebar active={tab} onSelect={setTab} user={viewer} />

      <main id="main" className="min-w-0 flex-1">
        <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <div className="min-w-0 flex-1">
            <VerificationBanner state={verificationState} />

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
                  {UNIVERSITY_FILTERS.map((option) => {
                    const active = option === filter;
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFilter(option)}
                        aria-pressed={active}
                        className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                          active
                            ? 'bg-surface text-accent-fg'
                            : 'border border-edge bg-surface text-fg-muted hover:border-edge hover:bg-surface-muted'
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
                  visiblePosts.map((post, i) => <PostCard key={post.id} post={post} index={i} />)
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
            <GraduationCountdown year={viewer.graduationYear} month={viewer.graduationMonth} />
            <TrendingNotes notes={SEED_TRENDING} />
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
