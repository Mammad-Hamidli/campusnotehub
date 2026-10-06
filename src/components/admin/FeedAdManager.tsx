'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2, Megaphone, Search, X } from 'lucide-react';
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

type Listing = { featured: string[]; max: number; mentors: Candidate[] };
type Change = { promote?: string[]; demote?: string[] };

/**
 * The feed's ad slot, managed one mentor at a time or in bulk.
 *
 * Lists every mentor that can be promoted (approved, account in good
 * standing). The button on a row promotes or removes that mentor; ticking
 * rows and using the bar above the list does the same for all of them in ONE
 * request (PATCH /api/admin/feed-ad), which notifies each mentor whose status
 * changed. The feed shows one promoted mentor per visit within about half a
 * minute (GET /api/feed/ad is CDN-cached).
 */
export function FeedAdManager() {
  const t = useT();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminFetch<Listing>('/api/admin/feed-ad');
  /** 'bulk', a mentor id (that row's button), or null. One request at a time. */
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** The list a successful change returned, valid until the next GET replaces `data`. */
  const [saved, setSaved] = useState<{ base: Listing; featured: string[] } | null>(null);

  const max = data?.max ?? 0;
  const featured = useMemo(
    () => new Set(saved && saved.base === data ? saved.featured : data?.featured ?? []),
    [saved, data],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = data?.mentors ?? [];
    const matching = needle
      ? all.filter((m) => m.nickname.toLowerCase().includes(needle) || m.headline.toLowerCase().includes(needle))
      : all;
    // Promoted mentors first, so the current state is visible without scrolling.
    return [...matching].sort((a, b) => Number(featured.has(b.id)) - Number(featured.has(a.id)));
  }, [data, query, featured]);

  // Bulk actions take only the ticked rows that are VISIBLE: a row hidden by
  // the search box or gone after a reload is left out, so an action never
  // touches a mentor the operator cannot see.
  const picked = rows.filter((m) => selected.has(m.id));
  const toPromote = picked.filter((m) => !featured.has(m.id)).map((m) => m.id);
  const toDemote = picked.filter((m) => featured.has(m.id)).map((m) => m.id);
  const overLimit = featured.size + toPromote.length > max;

  const allPicked = rows.length > 0 && picked.length === rows.length;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = picked.length > 0 && !allPicked;
  }, [picked.length, allPicked]);

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function apply(change: Change, busyKey: string, single?: Candidate) {
    if (!data) return;
    setBusy(busyKey);
    try {
      const response = await fetch('/api/admin/feed-ad', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(t(body.error ?? 'errors.generic', { max: body.max ?? max }));
        // Somebody's eligibility changed under us: show the current list.
        if (body.ineligible) reload();
        return;
      }

      const result = body as { featured: string[]; added: string[]; removed: string[] };
      setSaved({ base: data, featured: result.featured });
      setSelected(new Set());
      if (single) {
        toast.success(t(change.promote ? 'admin.feedAd.promoted' : 'admin.feedAd.removed', { nickname: single.nickname }));
      } else if (result.added.length + result.removed.length === 0) {
        toast.info(t('admin.feedAd.unchanged'));
      } else {
        toast.success(t('admin.feedAd.updated', { added: result.added.length, removed: result.removed.length }));
      }
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card mt-4 overflow-hidden" aria-labelledby="feed-ad-heading">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge p-4">
        <div className="min-w-0">
          <h2 id="feed-ad-heading" className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-fg">
            <Megaphone className="h-4 w-4 text-accent" aria-hidden="true" />
            {t('admin.feedAd.title')}
            {data && (
              <Badge tone={featured.size >= max ? 'warning' : 'accent'}>
                {t('admin.feedAd.count', { count: featured.size, max })}
              </Badge>
            )}
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-fg-muted">
            {t('admin.feedAd.description', { max })}
          </p>
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
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-surface-muted px-4 py-2">
            <label className="flex items-center gap-2 text-xs font-medium text-fg-muted">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allPicked}
                onChange={() => setSelected(allPicked ? new Set() : new Set(rows.map((m) => m.id)))}
                disabled={busy !== null}
                className="h-4 w-4 shrink-0 accent-accent"
              />
              {picked.length > 0 ? t('admin.feedAd.selected', { count: picked.length }) : t('admin.feedAd.selectAll')}
            </label>
            {picked.length > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {overLimit && toPromote.length > 0 && (
                  <span className="text-2xs text-warn" role="status">
                    {t('admin.feedAd.errors.limit', { max })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void apply({ promote: toPromote }, 'bulk')}
                  disabled={busy !== null || toPromote.length === 0 || overLimit}
                  className="btn-primary px-3 py-1.5 text-xs"
                >
                  {busy === 'bulk' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t('admin.feedAd.promoteSelected', { count: toPromote.length })}
                </button>
                <button
                  type="button"
                  onClick={() => void apply({ demote: toDemote }, 'bulk')}
                  disabled={busy !== null || toDemote.length === 0}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  {t('admin.feedAd.removeSelected', { count: toDemote.length })}
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  disabled={busy !== null}
                  title={t('admin.feedAd.clearSelection')}
                  aria-label={t('admin.feedAd.clearSelection')}
                  className="btn-secondary px-2 py-1.5 text-xs"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>

          <ul className="max-h-96 divide-y divide-edge overflow-y-auto">
            {rows.map((mentor) => {
              const promoted = featured.has(mentor.id);
              return (
                <li key={mentor.id} className={`flex items-center gap-3 px-4 py-2.5 ${promoted ? 'bg-accent-soft' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(mentor.id)}
                    onChange={() => toggleRow(mentor.id)}
                    disabled={busy !== null}
                    aria-label={t('admin.feedAd.selectRow', { nickname: mentor.nickname })}
                    className="h-4 w-4 shrink-0 accent-accent"
                  />
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
                    onClick={() =>
                      void apply(promoted ? { demote: [mentor.id] } : { promote: [mentor.id] }, mentor.id, mentor)
                    }
                    disabled={busy !== null || (!promoted && featured.size >= max)}
                    aria-pressed={promoted}
                    title={t(promoted ? 'admin.feedAd.remove' : 'admin.feedAd.promote')}
                    className={`${promoted ? 'btn-primary' : 'btn-secondary'} shrink-0 px-3 py-1.5 text-xs`}
                  >
                    {busy === mentor.id ? (
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
        </>
      )}
    </section>
  );
}
