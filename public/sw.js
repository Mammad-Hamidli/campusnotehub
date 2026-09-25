/**
 * Retirement worker: unregisters itself. Nothing registers /sw.js any more.
 *
 * The browser-install (PWA) path was replaced by the native Windows app in
 * desktop/. Browsers that visited while the PWA shipped still hold a
 * registration for this URL, and deleting the file would not remove it: a 404
 * on the update check fails the update but keeps the old worker registered
 * indefinitely. Serving this changed script instead makes the next update check
 * install it, and on activation it removes the registration. Like its
 * predecessor it has no fetch handler, so it never touches a request.
 *
 * A returning visitor's browser checks for an update on its first navigation
 * and is cleaned up then. Safe to delete once past visitors have had a few
 * weeks to come back.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.registration.unregister()));
