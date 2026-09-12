import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nextEnvModule from '@next/env';

/**
 * Loads the project's .env files for STANDALONE entry points (tsx scripts,
 * the scheduler worker, the e2e runner) exactly the way Next.js does.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Inside `next dev` / `next start`, Next loads .env* before any app module
 * runs. A plain `tsx scripts/x.mts` has no such step, and ES imports are
 * evaluated before the importing file's body - so src/lib/firebase/admin.core
 * read an empty FIREBASE_PROJECT_ID at import time and threw "Firebase is not
 * configured", while the app itself connected fine.
 *
 * Import this FIRST, before anything that touches Firebase:
 *
 *   import '../src/server/load-env';
 *
 * Same loader (@next/env), same files, same precedence as Next:
 * .env.$(NODE_ENV).local, .env.local (skipped for test), .env.$(NODE_ENV), .env
 * - and variables already set in the real environment always win, so a
 * deployment's secret store is never overridden by a file.
 *
 * A no-op inside the Next runtime (NEXT_RUNTIME is set there): Next has
 * already loaded the environment and this must never change app behaviour.
 */
const nextEnv =
  (nextEnvModule as unknown as { default?: typeof nextEnvModule }).default ?? nextEnvModule;

if (!process.env.NEXT_RUNTIME) {
  // Project root, from this file's location rather than the caller's cwd, so a
  // script run from another directory still finds the right .env files.
  // __dirname exists when this file is loaded as CommonJS (tsx), import.meta
  // when it is loaded as ESM (node's native TypeScript, e.g. scripts/e2e.mjs).
  const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  nextEnv.loadEnvConfig(resolve(here, '../..'), process.env.NODE_ENV !== 'production', {
    info: () => {},
    error: console.error,
  });
}
