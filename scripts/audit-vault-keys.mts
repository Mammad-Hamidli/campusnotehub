/**
 * Read-only audit: are the vault keys on this machine the ones that sealed the
 * data in Firestore, and do they match production?
 *
 *   npx tsx scripts/audit-vault-keys.mts
 *   npx tsx scripts/audit-vault-keys.mts --compare .env.vercel.production
 *   npx tsx scripts/audit-vault-keys.mts --compare .env.vercel.production --firestore [--user <id>]
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS
 * ---------------------------------------------------------------------------
 * vault.ts derives its AES key from `VAULT_KEY || PII_HASH_PEPPER`. Two
 * environments disagree when either the chosen VARIABLE differs (VAULT_KEY set
 * on one side only) or its VALUE does - and a value can differ invisibly: a
 * trailing newline from `echo $X | vercel env add`, quotes pasted into the
 * dashboard, a pepper regenerated when the variable was re-created.
 *
 *  1. Local config, loaded exactly as `next dev` loads it (@next/env).
 *  2. --compare FILE: the same for another env file, typically the output of
 *     `vercel env pull`, with a side-by-side verdict.
 *  3. --firestore: the decisive test. Every sealed TOTP secret of the target
 *     users is tried against every candidate key, and every stored emailHash
 *     against every candidate pepper - so the DATA says which key wrote it,
 *     even when Vercel will not hand a Sensitive value to `env pull`.
 *     Targets: --user ids, else every staff account plus every `mfa` doc.
 *     --project <id> reads another Firebase project (credentials permitting).
 *
 * A value `vercel env pull` withholds arrives as the literal `[SENSITIVE]`.
 * It is treated as UNKNOWN, never compared: comparing against the placeholder
 * reports a mismatch that says nothing about the real key.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 * ---------------------------------------------------------------------------
 * Write anything (Firestore is only ever `.get()`), or print a secret, a
 * decrypted value or an email. Keys appear only as a 16-hex HMAC fingerprint:
 * safe to paste into a ticket, and equal on two sides only if the keys are.
 *
 * Exit code: 0 no mismatch found, 1 mismatch found, 2 could not run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';

const { values: args } = parseArgs({
  options: {
    compare: { type: 'string' },
    firestore: { type: 'boolean', default: false },
    user: { type: 'string', multiple: true },
    project: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(
    'Usage: npx tsx scripts/audit-vault-keys.mts [--compare <env file>] [--firestore] [--user <id> ...] [--project <id>]',
  );
  process.exit(0);
}

// Before any app module is imported: they read process.env.
nextEnv.loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });
if (args.project) process.env.FIREBASE_PROJECT_ID = args.project;

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Mirrors of vault.ts and hash.ts. selfTest() proves they still agree with the
// real modules, so a change there fails this script instead of fooling it.
// ---------------------------------------------------------------------------

const IV_BYTES = 12;
const TAG_BYTES = 16;

const deriveVaultKey = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'campusnotehub-vault', 'field-encryption:v1', 32));

function aad(context: Record<string, string>): Buffer {
  const entries = Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Buffer.from(JSON.stringify(entries), 'utf8');
}

/** vault.open() with an explicit key; answers only "does it authenticate". */
function opensWith(key: Buffer, packed: string, context: Record<string, string>): boolean {
  const [version, payload] = packed.split('.', 2);
  if (version !== 'v1' || !payload) return false;
  const raw = Buffer.from(payload, 'base64');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    plain.fill(0);
    return true;
  } catch {
    return false;
  }
}

const emailHashWith = (pepper: string, email: string) =>
  createHmac('sha256', pepper).update(`email:${email.trim().toLowerCase()}`).digest('hex');

/** One-way, fixed-message HMAC: identifies a key without revealing it. */
const fingerprint = (key: Buffer | string | null) =>
  key === null ? '(none)' : createHmac('sha256', key).update('campusnotehub:key-audit:v1').digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// One environment's keys
// ---------------------------------------------------------------------------

/** What `vercel env pull` writes in place of a Sensitive value it will not reveal. */
const WITHHELD = '[SENSITIVE]';

type Side = {
  label: string;
  vaultVar: 'VAULT_KEY' | 'PII_HASH_PEPPER' | null;
  /** Null when absent OR withheld: either way there is nothing to compare. */
  vaultKey: Buffer | null;
  pepper: string | null;
  projectId: string | null;
  /** Variables `vercel env pull` would not reveal. */
  withheld: string[];
  warnings: string[];
};

function describe(label: string, rawEnv: Env): Side {
  const warnings: string[] = [];
  const withheld = Object.keys(rawEnv).filter((name) => rawEnv[name] === WITHHELD);
  for (const name of ['VAULT_KEY', 'PII_HASH_PEPPER', 'FIREBASE_PROJECT_ID'].filter((n) => withheld.includes(n))) {
    warnings.push(`${name} is withheld by Vercel (Sensitive) - its value cannot be compared`);
  }
  // A withheld variable IS set on that side, so it still decides which one
  // vault.ts reads - only its value is unknown.
  const env: Env = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, v === WITHHELD ? undefined : v]));
  const isSet = (name: string) => withheld.includes(name) || !!env[name];

  for (const name of ['VAULT_KEY', 'PII_HASH_PEPPER'] as const) {
    const value = env[name];
    if (value === undefined) continue;
    if (value === '') {
      warnings.push(`${name} is present but EMPTY`);
      continue;
    }
    if (value !== value.trim()) warnings.push(`${name} has leading/trailing whitespace (length ${value.length}, trimmed ${value.trim().length})`);
    if (/^["']|["']$/.test(value)) warnings.push(`${name} starts or ends with a quote character`);
    if (/\\n|\\r/.test(value)) warnings.push(`${name} contains a literal \\n or \\r`);
    if (value.startsWith('change-me')) warnings.push(`${name} is the placeholder value`);
  }
  if (env.PII_HASH_PEPPER && !/^[0-9a-f]{64}$/i.test(env.PII_HASH_PEPPER)) {
    warnings.push(`PII_HASH_PEPPER is not 64 hex chars as .env.example asks (length ${env.PII_HASH_PEPPER.length})`);
  }
  if (!isSet('PII_HASH_PEPPER')) warnings.push('PII_HASH_PEPPER is unset (dev falls back to a constant; production throws)');

  // Exactly vault.ts: `||`, so an empty VAULT_KEY falls through to the pepper.
  const vaultVar = isSet('VAULT_KEY') ? 'VAULT_KEY' : isSet('PII_HASH_PEPPER') ? 'PII_HASH_PEPPER' : null;
  return {
    label,
    vaultVar,
    vaultKey: vaultVar && env[vaultVar] ? deriveVaultKey(env[vaultVar]!) : null,
    pepper: env.PII_HASH_PEPPER || null,
    projectId: env.FIREBASE_PROJECT_ID || env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || null,
    withheld,
    warnings,
  };
}

/** Minimal dotenv reader for the --compare file, matching dotenv's quoting rules. */
function parseEnvFile(path: string): Env {
  const env: Env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === '`') && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    env[match[1]] = value;
  }
  return env;
}

async function selfTest(local: Side): Promise<void> {
  if (!local.vaultKey) return;
  const { seal } = await import('../src/lib/crypto/vault');
  const { hashEmail } = await import('../src/lib/crypto/hash');
  const context = { userId: 'key-audit', purpose: 'totp' };
  if (!opensWith(local.vaultKey, seal(Buffer.from('probe'), context), context)) {
    throw new Error('self-test: this script no longer derives the key vault.ts uses - update the mirror above');
  }
  if (local.pepper && emailHashWith(local.pepper, ' Probe@Example.com ') !== hashEmail(' Probe@Example.com ')) {
    throw new Error('self-test: this script no longer computes the emailHash hash.ts does - update the mirror above');
  }
}

// ---------------------------------------------------------------------------
// Firestore: let the stored data name the key that wrote it
// ---------------------------------------------------------------------------

const iso = (value: unknown) => (value as { toDate?: () => Date } | null)?.toDate?.().toISOString() ?? null;

async function auditFirestore(sides: Side[], userIds: string[] | undefined): Promise<number> {
  const { adminDb } = await import('../src/lib/firebase/admin.core');
  const db = adminDb();
  let problems = 0;

  const emulator = process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR;
  console.log(`\nFirestore project: ${sides[0].projectId ?? '(unset)'}${emulator ? `  [EMULATOR ${emulator} - not real data]` : ''}`);
  for (const side of sides.slice(1)) {
    if (side.withheld.includes('FIREBASE_PROJECT_ID')) {
      console.log(`  NOTE ${side.label}'s FIREBASE_PROJECT_ID is withheld - confirm it is this project, or rerun with --project`);
    } else if (side.projectId && side.projectId !== sides[0].projectId) {
      console.log(`  WARNING ${side.label} points at project ${side.projectId}: the data read here is not what it serves`);
    }
  }

  // Staff AND every mfa doc: a second factor enrolled on an account with an
  // unexpected role (a duplicate created by Google sign-in, say) is exactly
  // the one a staff-only scan would miss. `.select()` reads ids, not secrets.
  let ids = userIds ?? [];
  if (!ids.length) {
    const [staff, enrolled] = await Promise.all([
      db.collection('users').where('role', 'in', ['ADMIN', 'MODERATOR']).select().get(),
      db.collection('mfa').select().get(),
    ]);
    console.log(`  ${staff.size} staff account(s), ${enrolled.size} mfa doc(s) in this project`);
    ids = [...new Set([...staff.docs, ...enrolled.docs].map((d) => d.id))];
  }

  /**
   * Tests `value` against every side whose key material is known. A side
   * whose key is withheld or unset is reported as unknown, never as failing.
   */
  const judge = <K>(what: string, material: (side: Side) => K | null, test: (key: K) => boolean) => {
    const known = sides.filter((s) => material(s) !== null);
    const unknown = sides.filter((s) => material(s) === null).map((s) => s.label);
    const passing = known.filter((s) => test(material(s)!)).map((s) => s.label);
    const verdict =
      passing.length === 0
        ? 'MISMATCH (no known key opens it)'
        : passing.length === known.length
          ? 'OK'
          : 'MISMATCH';
    if (verdict !== 'OK') problems++;
    const tail = unknown.length ? `; unknown: ${unknown.join(', ')}` : '';
    console.log(`    ${what.padEnd(20)} ${verdict.padEnd(33)} works with: ${passing.join(', ') || 'none'}${tail}`);
  };

  for (const id of ids) {
    const [userSnap, credSnap, mfaSnap] = await Promise.all([
      db.collection('users').doc(id).get(),
      db.collection('credentials').doc(id).get(),
      db.collection('mfa').doc(id).get(),
    ]);
    const user = userSnap.data();
    console.log(`\n  ${id}  (${user?.nickname ?? '?'}, ${user?.role ?? '?'})`);

    const email = user?.email as string | undefined;
    const emailHash = credSnap.data()?.emailHash as string | undefined;
    if (email && emailHash) {
      judge('emailHash (pepper)', (s) => s.pepper, (pepper) => emailHashWith(pepper, email) === emailHash);
    }
    else console.log('    emailHash            (no email or credentials doc)');

    if (!mfaSnap.exists) {
      console.log('    mfa                  not enrolled');
      continue;
    }
    const mfa = mfaSnap.data()!;
    const context = { userId: id, purpose: 'totp' };
    for (const field of ['totpSecretSealed', 'pendingSecretSealed'] as const) {
      const sealed = mfa[field] as string | null;
      if (sealed) judge(field, (s) => s.vaultKey, (key) => opensWith(key, sealed, context));
      else console.log(`    ${field.padEnd(20)} null`);
    }
    console.log(
      `    enrolledAt=${iso(mfa.enrolledAt)} pendingCreatedAt=${iso(mfa.pendingCreatedAt)} ` +
        `lastUsedStep=${mfa.lastUsedStep} failedCount=${mfa.failedCount} lockedUntil=${iso(mfa.lockedUntil)}`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const sides: Side[] = [describe('local', process.env)];
  if (args.compare) {
    if (!existsSync(args.compare)) throw new Error(`--compare file not found: ${args.compare}`);
    sides.push(describe(basename(args.compare), parseEnvFile(args.compare)));
  }
  await selfTest(sides[0]);

  console.log('Vault key audit (read-only; fingerprints only)\n');
  console.log(`  ${'side'.padEnd(28)} ${'vault key from'.padEnd(16)} ${'vault key fp'.padEnd(17)} pepper fp`);
  const show = (s: Side, key: Buffer | string | null, name: string | null) =>
    key === null && name && s.withheld.includes(name) ? '(withheld)' : fingerprint(key);
  for (const s of sides) {
    console.log(
      `  ${s.label.padEnd(28)} ${(s.vaultVar ?? '(none)').padEnd(16)} ` +
        `${show(s, s.vaultKey, s.vaultVar).padEnd(17)} ${show(s, s.pepper, 'PII_HASH_PEPPER')}`,
    );
  }
  for (const s of sides) for (const w of s.warnings) console.log(`  WARNING [${s.label}] ${w}`);

  let problems = 0;
  if (sides.length === 2) {
    console.log('');
    const [a, b] = sides;
    const compare = (what: string, x: Buffer | string | null, y: Buffer | string | null) => {
      if (x === null || y === null) return console.log(`  ${what}: UNKNOWN (withheld or unset on one side) - use --firestore`);
      const same = fingerprint(x) === fingerprint(y);
      if (!same) problems++;
      console.log(`  ${what}: ${same ? 'MATCH' : 'MISMATCH'}`);
    };
    compare('vault key', a.vaultKey, b.vaultKey);
    compare('pepper   ', a.pepper, b.pepper);
    if (a.vaultVar !== b.vaultVar) {
      problems++;
      console.log(`  vault key source differs: ${a.label}=${a.vaultVar} vs ${b.label}=${b.vaultVar}`);
    }
  }

  if (args.firestore) problems += await auditFirestore(sides, args.user);

  console.log(problems ? `\n${problems} mismatch(es) found.` : '\nNo mismatch found.');
  return problems ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`audit-vault-keys: ${error.message}`);
    process.exit(2);
  },
);
