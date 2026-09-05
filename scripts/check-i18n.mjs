/**
 * CI guard: the three locale bundles must expose exactly the same key set and
 * the same ICU placeholders. A missing key ships a raw key path to a user; a
 * mismatched placeholder throws at render time in that locale only, which is
 * exactly the kind of bug that reaches production because nobody tests in AZ.
 *
 * Usage: node scripts/check-i18n.mjs
 */
import { readFileSync } from 'node:fs';

const LOCALES = ['az', 'en', 'ru'];
const REFERENCE = 'en';

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = String(v);
  }
  return out;
};

const placeholders = (s) =>
  [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort().join(',');

const bundles = Object.fromEntries(
  LOCALES.map((l) => [l, flatten(JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')))]),
);

const refKeys = Object.keys(bundles[REFERENCE]);
const problems = [];

for (const locale of LOCALES) {
  const keys = Object.keys(bundles[locale]);
  for (const k of refKeys) {
    if (!(k in bundles[locale])) problems.push(`${locale}: MISSING ${k}`);
    else if (placeholders(bundles[REFERENCE][k]) !== placeholders(bundles[locale][k]))
      problems.push(
        `${locale}: PLACEHOLDER MISMATCH ${k} ` +
          `(${REFERENCE}: ${placeholders(bundles[REFERENCE][k]) || 'none'} | ` +
          `${locale}: ${placeholders(bundles[locale][k]) || 'none'})`,
      );
  }
  for (const k of keys) if (!refKeys.includes(k)) problems.push(`${locale}: EXTRA ${k}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} i18n problem(s).`);
  process.exit(1);
}
console.log(`i18n OK - ${refKeys.length} keys x ${LOCALES.length} locales`);
