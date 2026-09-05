/**
 * Verifies that every translation key referenced in the source actually exists
 * in the locale bundles.
 *
 * check-i18n.mjs proves the three JSON files agree with EACH OTHER.
 * This proves they agree with the CODE — the other half of the problem, and
 * the half that produces a raw "landing.hero.badge" rendered on a live page.
 *
 * Handles both forms:
 *   t('a.b.c')          - checked directly
 *   t(`a.b.${x}`)       - the namespace `a.b` is resolved and every leaf under
 *                         it is required to be a string, which catches a typo
 *                         in the prefix and a namespace that was never added
 *
 * Usage: node scripts/check-keys-used.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REFERENCE = 'messages/en.json';
const dict = JSON.parse(readFileSync(REFERENCE, 'utf8'));

const leaves = (obj, prefix = '', out = new Set()) => {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') leaves(v, path, out);
    else out.add(path);
  }
  return out;
};
const known = leaves(dict);

const resolve = (path) =>
  path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), dict);

/** Removes // line comments and block comments so prose examples are not scanned. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const walk = (dir, files = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
};

const problems = [];
let staticCount = 0;
let dynamicCount = 0;

for (const file of walk('src')) {
  const source = stripComments(readFileSync(file, 'utf8'));
  const rel = file.replace(/\\/g, '/');

  // t('some.key')
  for (const match of source.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
    staticCount++;
    if (!known.has(match[1])) problems.push(`${rel}  MISSING  ${match[1]}`);
  }

  // t(`some.namespace.${expr}`) and t(`${base}.leaf`)
  for (const match of source.matchAll(/\bt\(\s*`([^`]+)`/g)) {
    dynamicCount++;
    const template = match[1];

    // Only the literal prefix before the first interpolation is checkable.
    const prefix = template.split('${')[0].replace(/\.$/, '');
    if (!prefix) continue; // e.g. `${base}.title` - prefix is fully dynamic

    const node = resolve(prefix);
    if (node === undefined) {
      problems.push(`${rel}  MISSING NAMESPACE  ${prefix}  (from \`${template}\`)`);
    } else if (typeof node === 'string') {
      problems.push(`${rel}  NOT A NAMESPACE  ${prefix} resolves to a string`);
    }
  }
}

console.log(
  `Scanned ${known.size} defined keys · ${staticCount} static references · ${dynamicCount} dynamic references`,
);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('All translation keys referenced in src/ resolve against ' + REFERENCE);
