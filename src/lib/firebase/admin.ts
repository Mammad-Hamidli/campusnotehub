import 'server-only';

/**
 * The Firebase Admin SDK, for application code.
 *
 * ---------------------------------------------------------------------------
 * WHY `server-only` IS THE FIRST LINE
 * ---------------------------------------------------------------------------
 * This module reaches a service account, which bypasses every security rule.
 * Importing it from a client component would ship a private key to the
 * browser. The marker makes that a BUILD failure with an explicit message
 * rather than a silent catastrophe - the same guard already applied to
 * src/lib/media/images.ts after sharp leaked into the client bundle and took
 * the whole app down.
 *
 * There is no browser-side Firebase client: pages go through the API routes,
 * and firebase/firestore.rules refuse direct client access.
 *
 * The implementation is in ./admin.core so that CLI scripts, which cannot load
 * `server-only`, can still use it.
 */
export {
  adminApp,
  adminAuth,
  adminBucket,
  adminDb,
  usingEmulator,
  STORAGE_BUCKET,
} from './admin.core';
