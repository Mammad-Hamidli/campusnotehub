import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

/**
 * ESLint 9 flat config wrapping Next's shareable configs.
 *
 * Without a config `next lint` stops at an interactive setup prompt, which is
 * why lint had never actually run on this codebase.
 */
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'graphify-out/**', 'services/**', 'next-env.d.ts'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];
