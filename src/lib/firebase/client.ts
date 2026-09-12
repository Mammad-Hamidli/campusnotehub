'use client';

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';

/**
 * The Firebase client SDK.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE IS PUBLIC, AND THAT IS FINE
 * ---------------------------------------------------------------------------
 * A Firebase web config - apiKey, projectId, appId - is not a secret. It is an
 * identifier for the project, shipped in every client that has ever used
 * Firebase, and Google documents it as such. What protects the data is the
 * SECURITY RULES plus the ID token, not the obscurity of these values.
 *
 * That is exactly why they are NEXT_PUBLIC_*: they are meant to reach the
 * browser. The service account, which genuinely is a secret and bypasses every
 * rule, lives in src/lib/firebase/admin.ts behind a `server-only` marker and
 * must never appear here.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CLIENT SDK IS ACTUALLY FOR IN THIS APPLICATION
 * ---------------------------------------------------------------------------
 * Authentication, and nothing else for now. Every data read still goes through
 * the API routes, because the visibility rules this product enforces - a
 * FOLLOWERS-only post, a purchased note, a frozen account's capability set -
 * need joins and a capability table that a Firestore rule cannot express
 * without several reads per document. The rules exist to close the direct path,
 * not because the app depends on it.
 */

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/** False until the project is configured, so the UI can degrade rather than throw. */
export const firebaseConfigured = Boolean(config.apiKey && config.projectId);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

function clientApp(): FirebaseApp {
  if (!firebaseConfigured) {
    throw new Error(
      'Firebase client is not configured: set NEXT_PUBLIC_FIREBASE_API_KEY and NEXT_PUBLIC_FIREBASE_PROJECT_ID.',
    );
  }
  // getApps() first: Next hot-reloads modules in development, and a second
  // initializeApp() with the same name throws.
  app ??= getApps().length ? getApp() : initializeApp(config);
  return app;
}

export function clientAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(clientApp());
    const host = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
    if (host) {
      // Guarded so a hot reload does not reconnect an already-connected
      // emulator, which throws.
      try {
        connectAuthEmulator(authInstance, `http://${host}`, { disableWarnings: true });
      } catch {
        /* already connected */
      }
    }
  }
  return authInstance;
}

export function clientDb(): Firestore {
  if (!dbInstance) {
    dbInstance = getFirestore(clientApp());
    const host = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
    if (host) {
      const [hostname, port] = host.split(':');
      try {
        connectFirestoreEmulator(dbInstance, hostname, Number(port));
      } catch {
        /* already connected */
      }
    }
  }
  return dbInstance;
}
