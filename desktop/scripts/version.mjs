/**
 * Keeps the desktop app's version identical in every file that carries it.
 *
 *   node scripts/version.mjs patch|minor|major   bump, print the new version
 *   node scripts/version.mjs 1.2.3               set (never lower), print it
 *   node scripts/version.mjs --check [1.2.3]     exit 1 unless all files agree (and equal 1.2.3)
 *
 * package.json is the source of truth: tauri.conf.json reads it ("version":
 * "../package.json"), so it names the installer, stamps the exe and is what the
 * app reports to the site's update notice. The lock files and Cargo.toml only
 * mirror it, but a stale copy is what a reader finds first, so they are kept
 * in step rather than documented as "ignore this one".
 *
 * Git (commit, tag desktop-vX.Y.Z, push) is left to the caller: the release
 * workflow in CI, or a person following desktop/README.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const desktop = new URL('../', import.meta.url);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const cargoName = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1];
if (!cargoName) fail('src-tauri/Cargo.toml has no [package] name');

/** [path, get(text), set(text, version)] for each copy of the version. */
const FILES = [
  ['package.json', (s) => JSON.parse(s).version, (s, v) => editJson(s, (j) => (j.version = v))],
  [
    'package-lock.json',
    (s) => JSON.parse(s).version,
    (s, v) => editJson(s, (j) => (j.version = j.packages[''].version = v)),
  ],
  ['src-tauri/Cargo.toml', ...regexField(/^(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m)],
  ['src-tauri/Cargo.lock', ...regexField(new RegExp(`(^name = "${cargoName}"\\r?\\nversion = ")([^"]+)(")`, 'm'))],
];

const [arg, expected] = process.argv.slice(2);
if (arg === '--check') check(expected);
else if (arg) bump(arg);
else fail('usage: node scripts/version.mjs patch|minor|major|X.Y.Z | --check [X.Y.Z]');

function check(expected) {
  const want = expected ?? FILES[0][1](read(FILES[0][0]));
  const wrong = FILES.map(([path, get]) => [path, get(read(path))]).filter(([, v]) => v !== want);
  for (const [path, v] of wrong) console.error(`${path}: ${v}, expected ${want}`);
  if (wrong.length) {
    fail(expected ? `desktop version is not ${want}` : `out of sync - run: node scripts/version.mjs ${want}`);
  }
  console.log(want);
}

function bump(arg) {
  const current = parse(FILES[0][1](read(FILES[0][0])), 'package.json');
  const next =
    arg === 'major' ? [current[0] + 1, 0, 0]
    : arg === 'minor' ? [current[0], current[1] + 1, 0]
    : arg === 'patch' ? [current[0], current[1], current[2] + 1]
    : parse(arg, 'the requested version');
  if (compare(next, current) < 0) fail(`${next.join('.')} is lower than the current ${current.join('.')}`);

  const version = next.join('.');
  for (const [path, , set] of FILES) write(path, set(read(path), version));
  console.log(version);
}

function regexField(pattern) {
  const get = (s) => pattern.exec(s)?.[2];
  const set = (s, v) => {
    if (!pattern.test(s)) fail(`version field not found by ${pattern}`);
    return s.replace(pattern, (_, before, _old, after) => before + v + after);
  };
  return [get, set];
}

/** Rewrites JSON in npm's own format (2 spaces, trailing newline); write() restores CRLF. */
function editJson(text, mutate) {
  const json = JSON.parse(text);
  mutate(json);
  return JSON.stringify(json, null, 2) + '\n';
}

function read(path) {
  return readFileSync(new URL(path, desktop), 'utf8');
}

/** Keeps the file's existing line endings (a Windows checkout has CRLF). */
function write(path, text) {
  const crlf = read(path).includes('\r\n');
  writeFileSync(new URL(path, desktop), crlf ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'));
}

function parse(version, what) {
  const match = SEMVER.exec(version ?? '');
  if (!match) fail(`${what} is "${version}", not X.Y.Z`);
  return match.slice(1).map(Number);
}

function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function fail(message) {
  console.error(`version: ${message}`);
  process.exit(1);
}
