'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Loader2, MessageCircle, Search, UserCheck, UserPlus, UserRoundSearch, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { UserAvatar } from '@/components/ui/UserAvatar';
import type { ChatPeer } from '@/components/messages/MessagesPanel';

export type UserHit = ChatPeer & { headline: string | null; following: boolean; requested: boolean; canFollow: boolean };
export type UserPage = { users: UserHit[]; nextCursor: string | null };

/** Long enough to skip the keystrokes of a word being typed, short enough to feel live. */
const DEBOUNCE_MS = 200;
/** What a username can contain, as the server matches it (lowercase, no "@"). */
export const HANDLE_FRAGMENT = /^[a-z0-9_]{1,24}$/;
/** Rows in the dropdown; the rest are one click away on /search. */
const DROPDOWN_LIMIT = 10;

/** Normalises typed input to what the server matches: lowercase, no leading "@". */
export const toFragment = (query: string) => query.trim().replace(/^@/, '').toLowerCase();

/** One page of GET /api/search/users. Rejects on a non-2xx answer. */
export async function fetchUserPage(
  fragment: string,
  options: { limit: number; after?: string | null; signal?: AbortSignal },
): Promise<UserPage> {
  const params = new URLSearchParams({ q: fragment, limit: String(options.limit) });
  if (options.after) params.set('after', options.after);
  const response = await fetch(`/api/search/users?${params}`, { signal: options.signal, cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as UserPage;
}

/**
 * Live search for people by USERNAME (GET /api/search/users), matching from
 * the start of the handle.
 *
 * Results follow the typing: a request per pause (debounced), the previous
 * one aborted the moment the query changes so an older, slower answer can
 * never overwrite a newer one, and every answer kept for the life of the
 * component, so backspacing re-shows a result without asking again. Input a
 * handle cannot contain is answered here, with a hint, without a request.
 *
 * At most ten rows: when the server reports more, a "View all results" link
 * opens /search with the full, paginated list.
 *
 * `pick` turns each row into a single button (the messages panel's "new
 * message" picker); otherwise a row links to the profile and, with
 * `onMessage`, offers a message button.
 */
export function UserSearch({
  onMessage,
  onPick,
  autoFocus = false,
  className = '',
}: {
  onMessage?: (user: UserHit) => void;
  onPick?: (user: UserHit) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserHit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const cache = useRef(new Map<string, UserPage>());
  const inputId = useId();
  const statusId = useId();

  const fragment = toFragment(query);
  const valid = HANDLE_FRAGMENT.test(fragment);

  useEffect(() => {
    const show = (page: UserPage) => {
      setResults(page.users);
      setHasMore(page.nextCursor !== null);
      setStatus('done');
    };
    if (!valid) {
      setResults([]);
      setHasMore(false);
      setStatus('idle');
      return;
    }
    const known = cache.current.get(fragment);
    if (known) {
      show(known);
      return;
    }

    setStatus('loading');
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchUserPage(fragment, { limit: DROPDOWN_LIMIT, signal: controller.signal })
        .then((page) => {
          cache.current.set(fragment, page);
          show(page);
        })
        .catch((error: Error) => {
          if (error.name === 'AbortError') return;
          setResults([]);
          setHasMore(false);
          setStatus('error');
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fragment, valid]);

  const typed = fragment.length > 0;
  const announce =
    status === 'done'
      ? results.length > 0
        ? t('dashboard.search.results', { count: results.length })
        : t('dashboard.search.empty', { query: fragment })
      : '';

  return (
    <section className={`card p-4 ${className}`} aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-fg">
        <UserRoundSearch className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        {t(onPick ? 'messages.newMessage.title' : 'dashboard.search.title')}
      </h2>

      <label htmlFor={inputId} className="sr-only">
        {t('dashboard.search.label')}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              setQuery('');
            }
          }}
          placeholder={t('dashboard.search.placeholder')}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={25}
          autoFocus={autoFocus}
          aria-describedby={statusId}
          className="input w-full py-1.5 pl-8 pr-8 text-sm"
        />
        {status === 'loading' ? (
          <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-fg-subtle" aria-hidden="true" />
        ) : (
          query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('common.close')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle hover:text-fg"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )
        )}
      </div>

      <p id={statusId} role="status" className="sr-only">
        {announce}
      </p>

      {typed && !valid && <p className="mt-2 text-2xs text-fg-muted">{t('dashboard.search.hint')}</p>}
      {status === 'error' && <p className="mt-2 text-2xs text-danger">{t('dashboard.search.error')}</p>}
      {status === 'done' && results.length === 0 && (
        <p className="mt-2 text-xs text-fg-muted">{t('dashboard.search.empty', { query: fragment })}</p>
      )}

      {results.length > 0 && (
        <ul className="mt-2 max-h-96 space-y-0.5 overflow-y-auto">
          {results.map((user) => (
            <li key={user.id}>
              {onPick ? (
                <button
                  type="button"
                  onClick={() => onPick(user)}
                  className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition hover:bg-surface-muted"
                >
                  <Hit user={user} />
                </button>
              ) : (
                <div className="flex items-center gap-1 rounded-lg transition hover:bg-surface-muted">
                  <Link
                    href={`/u/${encodeURIComponent(user.nickname)}`}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5"
                  >
                    <Hit user={user} />
                  </Link>
                  {onMessage && (
                    <button
                      type="button"
                      onClick={() => onMessage(user)}
                      title={t('dashboard.search.message', { nickname: user.nickname })}
                      aria-label={t('dashboard.search.message', { nickname: user.nickname })}
                      className="mr-1 shrink-0 rounded-lg p-1.5 text-fg-subtle transition hover:bg-surface-inset hover:text-accent"
                    >
                      <MessageCircle className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                  <SearchFollowButton user={user} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The picker keeps narrowing by typing; the people search links out. */}
      {hasMore && !onPick && (
        <Link
          href={`/search?q=${encodeURIComponent(fragment)}`}
          className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-xs font-medium text-accent transition hover:bg-surface-muted"
        >
          {t('dashboard.search.viewAll')}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

/** Follow/request state is included in the search payload and updated in place. */
export function SearchFollowButton({ user }: { user: UserHit }) {
  const t = useT();
  const toast = useToast();
  const [following, setFollowing] = useState(user.following);
  const [requested, setRequested] = useState(user.requested);
  const [busy, setBusy] = useState(false);
  const removable = following || requested;

  async function toggle() {
    if (busy || (!removable && !user.canFollow)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.nickname)}/follow`, {
        method: removable ? 'DELETE' : 'POST',
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(t(payload?.error ?? 'errors.generic'));
        return;
      }
      setFollowing(Boolean(payload.following));
      setRequested(Boolean(payload.requested));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  const label = following ? t('publicProfile.following') : requested ? t('publicProfile.requested') : t('publicProfile.follow');
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy || (!removable && !user.canFollow)}
      aria-pressed={following || requested}
      title={requested ? t('publicProfile.requestedHint') : undefined}
      className={`mr-1 inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition disabled:opacity-50 ${removable ? 'bg-surface-inset text-fg' : 'bg-accent text-accent-fg hover:brightness-105'}`}
    >
      {following ? <UserCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </button>
  );
}

/** Avatar, handle and headline: one search result, in the dropdown and on /search. */
export function Hit({ user }: { user: UserHit }) {
  const t = useT();
  return (
    <>
      <UserAvatar nickname={user.nickname} src={user.avatarUrl} verified={user.isVerified} verifiedLabel={t('profile.verified')} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">@{user.nickname}</span>
        {user.headline && <span className="block truncate text-2xs text-fg-muted">{user.headline}</span>}
      </span>
    </>
  );
}
