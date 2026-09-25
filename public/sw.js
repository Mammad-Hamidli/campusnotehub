/**
 * Service worker: installability only, deliberately NO fetch handler.
 *
 * The app is online-only and its correctness depends on every request reaching
 * the server untouched: the middleware's per-request CSP nonce, the no-store
 * headers that keep signed-out pages out of the back/forward cache, the 307s
 * through /api/auth/refresh, and the HttpOnly session cookies. A worker without
 * a fetch listener is never consulted for requests at all - the browser goes
 * straight to the network, exactly as it does with no worker installed - so
 * none of that can be cached, replayed or dropped here.
 *
 * Do not add a pass-through `fetch` listener "for completeness": Chrome no
 * longer requires one to install, and an empty handler still makes the browser
 * start this worker before every navigation, adding latency for nothing.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
