'use client';

import { useEffect } from 'react';

/**
 * Keeps a signed-in session alive across access-token expiry.
 *
 * The access token lasts 15 minutes; the refresh token lasts 30 days but is
 * only sent to /api/auth/*. So when any same-origin /api request comes back
 * 401, this refreshes ONCE (shared by every request that failed at the same
 * moment) and replays the request. If the refresh fails the replay is still
 * attempted once - another tab may have refreshed the shared cookie jar - and
 * whatever it returns is handed to the caller, whose existing 401 handling
 * (/logout?next=/login) then applies.
 *
 * Page navigations are handled server-side by the middleware and
 * GET /api/auth/refresh; this covers the requests a mounted page makes.
 */
type MarkedFetch = typeof fetch & { __sessionKeeper?: true };

/** Marks a background request that must not renew the session. */
export const PASSIVE_HEADER = 'x-session-passive';

let refreshing: Promise<boolean> | null = null;

function refreshOnce(originalFetch: typeof fetch): Promise<boolean> {
  refreshing ??= originalFetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, window.location.href);
}

export function SessionKeeper() {
  useEffect(() => {
    if ((window.fetch as MarkedFetch).__sessionKeeper) return;
    const originalFetch = window.fetch.bind(window);

    const wrapped: MarkedFetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (response.status !== 401) return response;

      const url = requestUrl(input);
      if (
        url.origin !== window.location.origin ||
        !url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/api/auth/')
      ) {
        return response;
      }
      // Background requests never refresh: a poll that renewed tokens would
      // keep an unattended tab signed in forever (see requireSession passive).
      if (new Headers(init?.headers).has(PASSIVE_HEADER)) return response;
      // Only replay requests whose body can be sent twice.
      if (init?.body instanceof ReadableStream || (input instanceof Request && input.body)) {
        return response;
      }

      await refreshOnce(originalFetch);
      return originalFetch(input, init);
    };
    wrapped.__sessionKeeper = true;

    window.fetch = wrapped;
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
