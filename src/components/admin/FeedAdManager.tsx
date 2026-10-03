'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2, Megaphone, Search } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { industryLabel } from '@/lib/mentors/display';
import { Badge, EmptyState, ErrorState, TableSkeleton, useAdminFetch, useToast } from './primitives';

type Candidate = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  isVerified: boolean;
  headline: string;
  industry: string;
  isAcceptingBookings: boolean;
};

/**
 * The feed's ad slot, managed in one click.
 *
 * Lists every mentor that can be promoted (approved, account in good
 * standing). The button on a row puts that mentor in the slot - replacing
 * whoever was there - and the same button on the promoted row empties it.
 * The feed's right rail shows the result above Trending notes within about
 * half a minute (GET /api/feed/ad is CDN-cached).
 */
export function FeedAdManager() {
  const t = useT();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminFetch<{ current: string | null; mentors: Candidate[] }>(
    '/api/admin/feed-ad',
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const current = data?.current ?? null;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = data?.mentors ?? [];
    const matching = needle
      ? all.filter((m) => m.nickname.toLowerCase().includes(needle) || m.headline.toLowerCase().includes(needle))
      : all;
    // The promoted mentor first, so the current state is visible without scrolling.
    return [...matching].sort((a, b) => Number(b.id === current) - Number(a.id === current));
  }, [data, query, current]);

  async function toggle(mentor: Candidate) {
    const promote = mentor.id !== current;
    setBusyId(mentor.id);
    try {
      const response = await fetch('/api/admin/feed-ad', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mentorId: promote ? mentor.id : null }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(t(body.error ?? 'errors.generic'));
        return;
      }
      toast.success(t(promote ? 'admin.feedAd.promoted' : 'admin.feedAd.removed', { nickname: mentor.nickname }));
      reload();
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card mt-4 overflow-hidden" aria-labelledby="feed-ad-heading">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge p-4">
        <div className="min-w-0">
          <h2 id="feed-ad-heading" className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Megaphone className="h-4 w-4 text-accent" aria-hidden="true" />
            {t('admin.feedAd.title')}
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-fg-muted">{t('admin.feedAd.description')}</p>
        </div>
        {(data?.mentors.length ?? 0) > 5 && (
          <label className="relative block w-full sm:w-56">
            <span className="sr-only">{t('admin.feedAd.search')}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('admin.feedAd.search')}
              className="input w-full py-1.5 pl-8 text-sm"
            />
          </label>
        )}
      </header>

      {error ? (
        <ErrorState message={t(error)} onRetry={reload} />
      ) : loading && !data ? (
        <TableSkeleton rows={3} cols={3} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('admin.feedAd.empty')} />
      ) : (
        <ul className="max-h-96 divide-y divide-edge overflow-y-auto">
          {rows.map((mentor) => {
            const promoted = mentor.id === current;
            return (
              <li key={mentor.id} className={`flex items-center gap-3 px-4 py-2.5 ${promoted ? 'bg-accent-soft' : ''}`}>
                <UserAvatar nickname={mentor.nickname} src={mentor.avatarUrl} verified={mentor.isVerified} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/mentors/${mentor.id}`} className="truncate text-sm font-medium text-fg hover:text-accent">
                      @{mentor.nickname}
                    </Link>
                    <Badge>{industryLabel(t, mentor.industry)}</Badge>
                    {!mentor.isAcceptingBookings && <Badge tone="warning">{t('mentors.notAccepting')}</Badge>}
                  </p>
                  <p className="truncate text-xs text-fg-muted">{mentor.headline}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void toggle(mentor)}
                  disabled={busyId !== null}
                  aria-pressed={promoted}
                  title={t(promoted ? 'admin.feedAd.remove' : 'admin.feedAd.promote')}
                  className={`${promoted ? 'btn-primary' : 'btn-secondary'} shrink-0 px-3 py-1.5 text-xs`}
                >
                  {busyId === mentor.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : promoted ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t(promoted ? 'admin.feedAd.inSlot' : 'admin.feedAd.promote')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
