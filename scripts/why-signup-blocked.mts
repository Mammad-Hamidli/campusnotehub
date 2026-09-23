/**
 * Explains, for one email address and/or phone number, exactly why signup
 * refuses it - and optionally removes the leftovers that refuse it wrongly.
 *
 *   npx tsx scripts/why-signup-blocked.mts --email a@b.com --phone 0501234567
 *   npx tsx scripts/why-signup-blocked.mts --nickname aysel
 *   npx tsx scripts/why-signup-blocked.mts --orphans            # audit all
 *   npx tsx scripts/why-signup-blocked.mts --orphans --apply    # and purge
 *
 * ===========================================================================
 * WHY THIS SCRIPT EXISTS
 * ===========================================================================
 * Signup uniqueness is NOT enforced by `users`. It is enforced by three
 * collections with independent lifetimes:
 *
 *   users/{id}           the account. Deleting it is what an operator thinks
 *                        of as "clearing the users".
 *   credentials/{id}     emailHash + phoneHash. A SEPARATE top-level
 *                        collection. Firestore has no cascade, so it survives
 *                        the account and keeps refusing the address.
 *   usernames/{handle}   the handle claim. Same story.
 *   blocklist/{type__h}  banned identifiers. Permanent BY DESIGN, and the one
 *                        refusal on this list that is not a bug.
 *
 * Emptying `users` from the console therefore fixes nothing on its own: the
 * documents doing the refusing were never in `users`. That is the false
 * positive this script diagnoses. createUser() now ignores and cleans such
 * leftovers as it meets them (see liveOwners() in repositories/users.ts); this
 * script is for finding out what is there first, and for clearing a database
 * in one pass rather than one signup at a time.
 *
 * Nothing is written without --apply.
 */
// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const apply = has('apply');
const email = flag('email')?.trim().toLowerCase();
const phone = flag('phone')?.trim();
const nickname = flag('nickname')?.trim();
const auditOrphans = has('orphans');

if (!email && !phone && !nickname && !auditOrphans) {
  console.error('Nothing to check. Pass --email, --phone, --nickname or --orphans.');
  process.exit(2);
}

const { adminDb } = await import('../src/lib/firebase/admin.core');
const { COLLECTIONS } = await import('../src/lib/firebase/collections');
const { hashEmail, hashPhone } = await import('../src/lib/crypto/hash');
const { usernameKey } = await import('../src/lib/auth/username');
const { normalizeAzPhone } = await import('../src/lib/auth/phone');

const db = adminDb();
const CREDENTIALS = 'credentials';
const PAGE = 500;

/** Reports whether the owning account document still exists. */
async function ownerState(userId: string): Promise<'live' | 'soft-deleted' | 'missing'> {
  const snap = await db.collection(COLLECTIONS.users).doc(userId).get();
  if (!snap.exists) return 'missing';
  return snap.get('deletedAt') ? 'soft-deleted' : 'live';
}

const verdicts: string[] = [];
const purge: FirebaseFirestore.DocumentReference[] = [];

async function explainHash(label: string, field: 'emailHash' | 'phoneHash', hash: string) {
  const snap = await db.collection(CREDENTIALS).where(field, '==', hash).limit(20).get();
  if (snap.empty) {
    verdicts.push(`${label}: no credential document. Not refused here.`);
    return;
  }
  for (const doc of snap.docs) {
    const state = await ownerState(doc.id);
    if (state === 'missing') {
      verdicts.push(
        `${label}: REFUSED BY A LEFTOVER - credentials/${doc.id} has no users/${doc.id}. ` +
          `This is the false positive; --apply removes it.`,
      );
      purge.push(doc.ref);
    } else {
      verdicts.push(`${label}: genuinely held by users/${doc.id} (${state}).`);
    }
  }
}

async function explainBlock(label: string, type: string, hash: string) {
  const id = `${type}__${Buffer.from(hash).toString('base64url')}`;
  const snap = await db.collection(COLLECTIONS.blocklist).doc(id).get();
  if (!snap.exists) return;
  const expiresAt = snap.get('expiresAt');
  verdicts.push(
    `${label}: on the BLOCKLIST (${type}, expires ${expiresAt ? String(expiresAt.toDate?.() ?? expiresAt) : 'never'}). ` +
      `That is a ban, not a bug - signup answers 403, not 409. Lift it with the moderation tools.`,
  );
}

if (email) {
  const snap = await db.collection(COLLECTIONS.users).where('email', '==', email).limit(20).get();
  for (const doc of snap.docs) {
    verdicts.push(
      `email ${email}: held by users/${doc.id} (${doc.get('deletedAt') ? 'soft-deleted' : 'live'}). ` +
        `A soft-deleted account keeps its address on purpose - identifiers are never recycled.`,
    );
  }
  if (snap.empty) verdicts.push(`email ${email}: no users document.`);
  await explainHash(`email ${email}`, 'emailHash', hashEmail(email));
  await explainBlock(`email ${email}`, 'EMAIL_HASH', hashEmail(email));
}

if (phone) {
  const e164 = normalizeAzPhone(phone);
  if (!e164) {
    verdicts.push(
      `phone ${phone}: NOT a valid Azerbaijani mobile number, so registration rejects it as ` +
        `invalid before any uniqueness check runs. Accepted operator codes are in src/lib/auth/phone.ts.`,
    );
  } else {
    verdicts.push(`phone ${phone}: normalises to ${e164}.`);
    await explainHash(`phone ${e164}`, 'phoneHash', hashPhone(e164));
    await explainBlock(`phone ${e164}`, 'PHONE_HASH', hashPhone(e164));
  }
}

if (nickname) {
  const key = usernameKey(nickname);
  if (!key) {
    verdicts.push(`nickname ${nickname}: does not satisfy USERNAME_PATTERN.`);
  } else {
    const claim = await db.collection(COLLECTIONS.usernames).doc(key).get();
    if (!claim.exists) verdicts.push(`nickname ${nickname}: no claim document.`);
    else {
      const owner = String(claim.get('userId'));
      const state = await ownerState(owner);
      if (state === 'missing') {
        verdicts.push(
          `nickname ${nickname}: REFUSED BY A LEFTOVER - usernames/${key} points at a missing users/${owner}.`,
        );
        purge.push(claim.ref);
      } else {
        verdicts.push(`nickname ${nickname}: genuinely held by users/${owner} (${state}).`);
      }
    }
  }
}

/**
 * The whole-database sweep. Paged and projection-only: no password hash and no
 * profile field is ever pulled over the wire, only document ids and the one
 * pointer each collection holds.
 */
if (auditOrphans) {
  const liveIds = new Set<string>();
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db.collection(COLLECTIONS.users).select().orderBy('__name__').limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    for (const doc of snap.docs) liveIds.add(doc.id);
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  let orphanCreds = 0;
  cursor = undefined;
  for (;;) {
    let query = db.collection(CREDENTIALS).select().orderBy('__name__').limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    for (const doc of snap.docs) {
      if (!liveIds.has(doc.id)) {
        orphanCreds += 1;
        purge.push(doc.ref);
      }
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  let orphanClaims = 0;
  cursor = undefined;
  for (;;) {
    let query = db.collection(COLLECTIONS.usernames).select('userId').orderBy('__name__').limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    for (const doc of snap.docs) {
      if (!liveIds.has(String(doc.get('userId')))) {
        orphanClaims += 1;
        purge.push(doc.ref);
      }
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  verdicts.push(
    `sweep: ${liveIds.size} user documents, ${orphanCreds} orphaned credentials, ` +
      `${orphanClaims} orphaned username claims.`,
  );
}

console.log('');
for (const line of verdicts) console.log(`  ${line}`);

// De-duplicated: --orphans and a targeted lookup can name the same document.
const unique = [...new Map(purge.map((ref) => [ref.path, ref])).values()];

if (unique.length === 0) {
  console.log('\n  Nothing to purge.\n');
} else if (!apply) {
  console.log(`\n  ${unique.length} leftover document(s) would be deleted. Re-run with --apply.\n`);
  for (const ref of unique.slice(0, 50)) console.log(`    ${ref.path}`);
  if (unique.length > 50) console.log(`    ... and ${unique.length - 50} more`);
  console.log('');
} else {
  // 500 is Firestore's write ceiling for one batch.
  for (let i = 0; i < unique.length; i += 500) {
    const batch = db.batch();
    for (const ref of unique.slice(i, i + 500)) batch.delete(ref);
    await batch.commit();
  }
  console.log(`\n  Deleted ${unique.length} leftover document(s).\n`);
}
