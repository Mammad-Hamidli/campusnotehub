/**
 * Removes a stale `.next` directory before `next dev` starts.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * Running `next dev` immediately after `next build` crashes on this machine:
 *
 *   EINVAL: invalid argument, readlink '...\.next\server\edge-runtime-webpack.js'
 *
 * Two things combine to cause it:
 *
 *  1. `next build` and `next dev` share the same `.next` directory but write
 *     incompatible artifacts into it. Dev's webpack walks the tree and tries
 *     to resolve entries the production build left behind.
 *  2. The project lives inside a OneDrive-synced folder. With Files On-Demand
 *     enabled, OneDrive replaces files with reparse points (cloud
 *     placeholders). Node's `readlink` on a placeholder returns EINVAL rather
 *     than the "not a symlink" error the caller expects, so the walk throws
 *     instead of skipping.
 *
 * Neither alone is usually fatal. Together they are, and the error names a
 * webpack file, which sends you looking in entirely the wrong place.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT JUST ALWAYS DELETE
 * ---------------------------------------------------------------------------
 * Blowing away `.next` on every `npm run dev` would work, and would also throw
 * out the incremental dev cache every single time — turning a ~2s warm start
 * into a ~20s cold compile on every restart.
 *
 * So it deletes only when `.next` actually contains a PRODUCTION build, which
 * is exactly the state that breaks dev. A `.next` holding only dev artifacts
 * is left alone. `BUILD_ID` is the marker: `next build` always writes it,
 * `next dev` never does.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const NEXT_DIR = join(process.cwd(), '.next');
const PRODUCTION_MARKERS = ['BUILD_ID', 'prerender-manifest.json', 'export-marker.json'];

if (!existsSync(NEXT_DIR)) {
  process.exit(0);
}

const isProductionBuild = PRODUCTION_MARKERS.some((marker) =>
  existsSync(join(NEXT_DIR, marker)),
);

if (!isProductionBuild) {
  // Dev cache only — leave it, that is the whole point of this check.
  process.exit(0);
}

console.log('[clean-next] .next holds a production build; removing it so `next dev` can start.');

/**
 * Retry the removal.
 *
 * OneDrive can hold a transient lock on a file it is mid-sync, which surfaces
 * as EPERM or EBUSY. A short backoff clears it in practice; failing loudly
 * after three tries is better than a half-deleted directory that produces an
 * even more confusing error on the next run.
 */
let lastError;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    rmSync(NEXT_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log('[clean-next] done.');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 3) {
      // Synchronous sleep: this runs before dev starts, so blocking is fine
      // and avoids pulling in a promise chain for a pre-script.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
}

console.error(
  `[clean-next] could not remove .next after 3 attempts: ${lastError?.message ?? lastError}\n` +
    '            Close any running dev server or editor holding files open, then retry.\n' +
    '            If this keeps happening, see the OneDrive note in README.md.',
);
process.exit(1);
