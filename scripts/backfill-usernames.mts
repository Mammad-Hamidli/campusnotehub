/**
 * Creates the `usernames/{key}` claim for every account that predates it.
 *
 *   npx tsx scripts/backfill-usernames.mts            # dry run: report only
 *   npx tsx scripts/backfill-usernames.mts --apply    # write missing claims
 *
 * Safe to re-run: an existing claim for the same user is left alone, and each
 * claim is written with a transactional create, so a signup that takes the
 * handle mid-run wins and is reported rather than overwritten.
 *
 * NOTHING IS GUESSED. Handles held by more than one account (possible before
 * claims existed: the old check was a query, and a migrated or hand-written
 * document could bypass it) get NO claim - login by that @handle resolves to
 * nobody until an operator decides who keeps it. Both accounts can still sign
 * in by email. The same applies to a nickname that fails USERNAME_PATTERN.
 */
// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';

const apply = process.argv.includes('--apply');

const { adminDb } = await import('../src/lib/firebase/admin.core');
const { COLLECTIONS } = await import('../src/lib/firebase/collections');
const { forFirestore } = await import('../src/lib/firebase/convert');
const { usernameKey } = await import('../src/lib/auth/username');

const db = adminDb();
const PAGE = 500;

type Row = { id: string; nickname: unknown; nicknameLower: unknown };

// Only the three fields needed: select() keeps profiles and PII off the wire.
const rows: Row[] = [];
let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
for (;;) {
  let query = db
    .collection(COLLECTIONS.users)
    .select('nickname', 'nicknameLower')
    .orderBy('__name__')
    .limit(PAGE);
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.get();
  for (const doc of snap.docs) {
    rows.push({ id: doc.id, nickname: doc.get('nickname'), nicknameLower: doc.get('nicknameLower') });
  }
  if (snap.size < PAGE) break;
  cursor = snap.docs[snap.docs.length - 1];
}

const byKey = new Map<string, string[]>();
const invalid: Row[] = [];
const drifted: Row[] = [];

for (const row of rows) {
  const key = typeof row.nickname === 'string' ? usernameKey(row.nickname) : null;
  if (!key) {
    invalid.push(row);
    continue;
  }
  // findUserByUsername() cross-checks nicknameLower, so a drifted value would
  // make the claim unusable. Reported, not rewritten: it is a profile field.
  if (row.nicknameLower !== key) drifted.push(row);
  byKey.set(key, [...(byKey.get(key) ?? []), row.id]);
}

const duplicates = [...byKey].filter(([, ids]) => ids.length > 1);
const candidates = [...byKey].filter(([, ids]) => ids.length === 1).map(([key, [id]]) => ({ key, id }));

let created = 0;
let present = 0;
const conflicts: { key: string; id: string; heldBy: string }[] = [];

for (const { key, id } of candidates) {
  const ref = db.collection(COLLECTIONS.usernames).doc(key);
  const outcome = await db.runTransaction(async (tx) => {
    const claim = await tx.get(ref);
    if (claim.exists) {
      const heldBy = claim.get('userId') as string;
      return heldBy === id ? ('present' as const) : { heldBy };
    }
    if (apply) tx.create(ref, forFirestore({ userId: id, createdAt: new Date() }));
    return 'created' as const;
  });
  if (outcome === 'present') present++;
  else if (outcome === 'created') created++;
  else conflicts.push({ key, id, heldBy: outcome.heldBy });
}

console.log(`\n  ${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'}`);
console.log(`    users scanned          ${rows.length}`);
console.log(`    claims ${apply ? 'created' : 'to create'}      ${created}`);
console.log(`    claims already present ${present}`);

const report = (title: string, lines: string[]) => {
  if (lines.length === 0) return;
  console.log(`\n  ${title} (${lines.length}) - no claim written:`);
  for (const line of lines) console.log(`    ${line}`);
};
report(
  'Handle shared by several accounts',
  duplicates.map(([key, ids]) => `@${key}: ${ids.join(', ')}`),
);
report(
  'Claim held by a different account',
  conflicts.map((c) => `@${c.key}: user ${c.id}, claim -> ${c.heldBy}`),
);
report(
  'Nickname fails USERNAME_PATTERN',
  invalid.map((r) => `${r.id}: ${JSON.stringify(r.nickname)}`),
);
report(
  'nicknameLower out of step (claim written, but login by handle fails until fixed)',
  drifted.map((r) => `${r.id}: ${JSON.stringify(r.nickname)} / ${JSON.stringify(r.nicknameLower)}`),
);

const problems = duplicates.length + conflicts.length + invalid.length + drifted.length;
console.log(problems ? `\n  ${problems} account(s) need an operator.\n` : '\n  Clean.\n');
process.exit(problems ? 2 : 0);
