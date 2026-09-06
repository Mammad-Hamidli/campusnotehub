import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * `npm test` was wired to vitest but no config or test file existed, so it
 * exited 1 with "No test files found" on a clean checkout. This makes the
 * script meaningful.
 *
 * environment: 'node' because everything under test here is server-side -
 * authorization helpers and zod schemas. A jsdom environment would only slow
 * the run down.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
