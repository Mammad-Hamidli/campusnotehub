import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

/**
 * ESLint 9 flat config wrapping Next's shareable configs.
 *
 * Run with `npm run lint` (plain `eslint .`: `next lint` is deprecated and is
 * removed in Next 16). Unlike `next lint`, this also covers scripts/ and the
 * root config files.
 */
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'graphify-out/**', 'services/**', 'desktop/src-tauri/target/**', 'next-env.d.ts'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];

export default config;
