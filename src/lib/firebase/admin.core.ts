import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

/**
 * The Firebase Admin SDK - implementation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM ./admin.ts
 * ---------------------------------------------------------------------------
 * `admin.ts` adds `import 'server-only'`, which makes importing it from a
 * client component a BUILD error. That guard is exactly what we want for
 * application code - a service account in the browser bundle would be
 * catastrophic - but the `server-only` package throws unconditionally outside
 * Next's bundler, so a plain `tsx scripts/migrate-to-firebase.mts` cannot use
 * it at all.
 *
 * So the implementation lives here and `admin.ts` re-exports it behind the
 * guard. Application code imports `./admin`; standalone scripts import
 * `./admin.core`. Neither can reach the browser: this module is only ever
 * pulled in by a server module or a CLI script.
 *
 * ---------------------------------------------------------------------------
 * WHY `server-only` IS THE FIRST LINE
 * ---------------------------------------------------------------------------
 * This module holds a service account, which bypasses every security rule.
 * Importing it from a client component would ship a private key to the
 * browser. The `server-only` marker makes that a BUILD failure with an
 * explicit message rather than a silent catastrophe - the same guard already
 * applied to src/lib/media/images.ts after sharp leaked into the client bundle
 * and took the whole app down.
 *
 * Client code uses src/lib/firebase/client.ts, which carries only the public
 * config and is subject to the security rules.
 *
 * ---------------------------------------------------------------------------
 * CREDENTIALS: THREE SOURCES, IN ORDER
 * ---------------------------------------------------------------------------
 *  1. FIREBASE_SERVICE_ACCOUNT - the JSON key as a single env var. This is the
 *     shape a deployment platform can hold in a secret store, so it is first.
 *  2. GOOGLE_APPLICATION_CREDENTIALS - a path, which is what `gcloud auth`
 *     and Cloud Run set. Handled by the SDK's own default lookup.
 *  3. The EMULATOR, when FIRESTORE_EMULATOR_HOST is set. No credentials are
 *     needed or used, and none should be: the emulator is not a trust
 *     boundary and pointing real keys at it would be a mistake, not a
 *     convenience.
 *
 * A missing configuration throws HERE, at first use, rather than producing a
 * client that fails later with an unrelated-looking error.
 */

/** True when the process is pointed at the local emulator suite. */
export const usingEmulator = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR,
);

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ??
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
  // The emulator accepts any project id; a stable one keeps its data
  // addressable across restarts.
  (usingEmulator ? 'campushub-local' : undefined);

/** Bucket for uploaded files. Defaults to the conventional name. */
export const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ??
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ??
  (PROJECT_ID ? `${PROJECT_ID}.appspot.com` : undefined);

function createApp(): App {
  if (getApps().length) return getApp();

  if (!PROJECT_ID) {
    throw new Error(
      'Firebase is not configured: set FIREBASE_PROJECT_ID (and credentials), ' +
        'or FIRESTORE_EMULATOR_HOST to use the local emulator.',
    );
  }

  // Emulator: no credentials, by design.
  if (usingEmulator) {
    return initializeApp({ projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET });
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    let parsed: { project_id?: string; client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON.');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key.');
    }
    return initializeApp({
      credential: cert({
        projectId: parsed.project_id ?? PROJECT_ID,
        clientEmail: parsed.client_email,
        // Secrets stores commonly escape the newlines in a PEM; unescaping
        // here means the value round-trips through any of them unchanged.
        privateKey: parsed.private_key.replace(/\\n/g, '\n'),
      }),
      projectId: PROJECT_ID,
      storageBucket: STORAGE_BUCKET,
    });
  }

  /**
   * Application Default Credentials - but only where they can exist.
   *
   * Off Google Cloud, with no GOOGLE_APPLICATION_CREDENTIALS and no gcloud ADC
   * file, the auth library's last resort is probing the GCE metadata server.
   * That probe has to time out first, so a missing key surfaced as every
   * Firestore-backed request stalling and then failing with an
   * unrelated-looking "Could not load the default credentials". Refusing here
   * turns it into one immediate, explicit configuration error.
   */
  const adcFile = join(
    process.env.APPDATA ?? join(homedir(), '.config'),
    'gcloud',
    'application_default_credentials.json',
  );
  const onGoogleCloud = Boolean(
    process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.GAE_ENV,
  );
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !onGoogleCloud && !existsSync(adcFile)) {
    throw new Error(
      'Firebase Admin has no credentials: set FIREBASE_SERVICE_ACCOUNT to the service-account ' +
        'JSON (on one line), or GOOGLE_APPLICATION_CREDENTIALS to its file path.',
    );
  }

  return initializeApp({ projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET });
}

/**
 * The caches live on `globalThis`, NOT in module scope.
 *
 * ---------------------------------------------------------------------------
 * WHY, AND THE BUG THAT PROVED IT NECESSARY
 * ---------------------------------------------------------------------------
 * A module-level `let cachedDb` is per MODULE INSTANCE, and a module instance
 * is not unique per process. Next.js re-evaluates modules on hot reload, and
 * builds separate registries for its server bundles, so this file can be
 * instantiated several times in one process.
 *
 * `firebase-admin` does not work that way: `getFirestore(app)` caches the
 * Firestore object on the APP and hands the same instance back every time. So
 * the second module instance saw `cachedDb === null`, called `getFirestore()`,
 * received the already-configured singleton, and called `.settings()` on it:
 *
 *     Error: Firestore has already been initialized. You can only call
 *     settings() once, and only before calling any other methods on a
 *     Firestore object.
 *
 * That threw on every request after the first hot reload - it turned login
 * into a 500. The App had already been protected against exactly this shape of
 * bug via `getApps()`; the Firestore handle had no equivalent guard.
 *
 * Caching on `globalThis` fixes it at the root: there is one entry per
 * process, shared by every module instance, so `settings()` is called exactly
 * once no matter how many times this file is evaluated.
 */
const globalForFirebase = globalThis as typeof globalThis & {
  __campushubFirebaseApp?: App;
  __campushubFirestore?: Firestore;
};

export function adminApp(): App {
  globalForFirebase.__campushubFirebaseApp ??= createApp();
  return globalForFirebase.__campushubFirebaseApp;
}

export function adminDb(): Firestore {
  if (globalForFirebase.__campushubFirestore) {
    return globalForFirebase.__campushubFirestore;
  }

  const firestore = getFirestore(adminApp());
  try {
    firestore.settings({
      // Undefined is how an optional field is expressed everywhere in this
      // codebase. Without this, writing one throws instead of omitting it,
      // which would force a `deleteUndefined` helper at every call site.
      ignoreUndefinedProperties: true,
    });
  } catch {
    /**
     * Already configured by an earlier instance whose globalThis entry we did
     * not see - possible if a bundle evaluated this file in an isolated
     * context. Swallowed rather than rethrown because the settings are already
     * applied: the desired state holds, and the only thing `settings()` was
     * objecting to is being told twice.
     *
     * Deliberately narrow: this catch covers ONE idempotent configuration
     * call, not any Firestore operation.
     */
  }

  globalForFirebase.__campushubFirestore = firestore;
  return firestore;
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}

export function adminBucket() {
  return getStorage(adminApp()).bucket(STORAGE_BUCKET);
}
