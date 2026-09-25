'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js so Chrome and Edge offer "Install app".
 *
 * The worker has no fetch handler (see public/sw.js), so registering it
 * changes nothing about how pages, API calls or cookies travel. A failure here
 * only means the install prompt is missing, never that the page is broken, so
 * it is swallowed rather than surfaced.
 *
 * `updateViaCache: 'none'` makes every update check hit the network, so a
 * changed sw.js is picked up on the next navigation instead of after the HTTP
 * cache expires.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
  }, []);

  return null;
}
