'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Loader2, Search, UserRoundSearch } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { BackLink } from '@/components/ui/BackLink';
import { HANDLE_FRAGMENT, Hit, fetchUserPage, toFragment, type UserHit } from '@/components/dashboard/UserSearch';

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 250;

type State =
  | { status: 'idle' | 'loading' | 'error' }
  | { status: 'done'; users: UserHit[]; nextCursor: string | null; more: 'idle' | 'loading' | 'error' };

/**
 * /search - every username matching a prefix, the page behind the dashboard
 * dropdown's "View all results".
 *
 * Same endpoint and matching rules as the dropdown, keyset-paginated with
 * "Load more". The query stays in the URL via a shallow history.replaceState
 * (Next keeps it in sync): no server re-render per keystroke, and Back leaves
 * the page instead of stepping through what was typed.
 */
export function UserSearchResults({ initialQuery }: { initialQuery: string }) {
  const t = useT();
  const inputId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<State>({ status: 'idle' });

  const fragment = toFragment(query);
  const valid = HANDLE_FRAGMENT.test(fragment);

  useEffect(() => {
    if (!valid) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      window.history.replaceState(null, '', `/search?q=${encodeURIComponent(fragment)}`);
      fetchUserPage(fragment, { limit: PAGE_SIZE, signal: controller.signal })
        .then((page) => setState({ status: 'done', ...page, more: 'idle' }))
        .catch((error: Error) => {
          if (error.name !== 'AbortError') setState({ status: 'error' });
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fragment, valid]);

  async function loadMore() {
    if (state.status !== 'done' || !state.nextCursor || state.more === 'loading') return;
    setState({ ...state, more: 'loading' });
    try {
      const page = await fetchUserPage(fragment, { limit: PAGE_SIZE, after: state.nextCursor });
      // Keyed by the cursor it continued from: a query changed meanwhile wins.
      setState((prev) =>
        prev.status === 'done' && prev.nextCursor === state.nextCursor
          ? { status: 'done', users: [...prev.users, ...page.users], nextCursor: page.nextCursor, more: 'idle' }
          : prev,
      );
    } catch {
      setState((prev) => (prev.status === 'done' ? { ...prev, more: 'error' } : prev));
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <BackLink fallbackHref="/dashboard" className="mb-3" />
      <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-fg">
        <UserRoundSearch className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
        {t('search.title')}
      </h1>

      <div className="card mt-4 p-4">
        <label htmlFor={inputId} className="sr-only">
          {t('dashboard.search.label')}
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input
            id={inputId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('dashboard.search.placeholder')}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={25}
            className="input w-full py-2 pl-9 text-sm"
          />
        </div>
        {fragment.length > 0 && !valid && <p className="mt-2 text-2xs text-fg-muted">{t('dashboard.search.hint')}</p>}
      </div>

      <section className="mt-4" aria-live="polite" aria-busy={state.status === 'loading'}>
        {state.status === 'loading' && (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-fg-subtle" aria-hidden="true" />
          </div>
        )}
        {state.status === 'error' && <p className="card p-6 text-center text-sm text-danger">{t('dashboard.search.error')}</p>}
        {state.status === 'done' && state.users.length === 0 && (
          <p className="card p-6 text-center text-sm text-fg-muted">{t('dashboard.search.empty', { query: fragment })}</p>
        )}
        {state.status === 'done' && state.users.length > 0 && (
          <>
            <p className="mb-2 text-xs text-fg-muted">
              {t(state.nextCursor ? 'search.shownSoFar' : 'dashboard.search.results', { count: state.users.length })}
            </p>
            <ul className="card divide-y divide-edge overflow-hidden">
              {state.users.map((user) => (
                <li key={user.id}>
                  <Link
                    href={`/u/${encodeURIComponent(user.nickname)}`}
                    className="flex min-w-0 items-center gap-2.5 px-3 py-2.5 transition hover:bg-surface-muted"
                  >
                    <Hit user={user} />
                  </Link>
                </li>
              ))}
            </ul>
            {state.nextCursor && (
              <div className="mt-3 flex flex-col items-center gap-1.5">
                <button type="button" onClick={loadMore} disabled={state.more === 'loading'} className="btn-secondary px-4 py-2 text-sm">
                  {state.more === 'loading' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {t('search.loadMore')}
                </button>
                {state.more === 'error' && <p className="text-2xs text-danger">{t('dashboard.search.error')}</p>}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
