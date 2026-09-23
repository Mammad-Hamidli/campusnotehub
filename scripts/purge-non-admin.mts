/**
 * Deletes every non-ADMIN account and everything that points at one.
 *
 *   npx tsx scripts/purge-non-admin.mts                  # dry run: report only
 *   npx tsx scripts/purge-non-admin.mts --apply --yes    # actually delete
 *   npx tsx scripts/purge-non-admin.mts --apply --yes --storage --cloudinary
 *   npx tsx scripts/purge-non-admin.mts --keep-roles ADMIN,MODERATOR
 *   npx tsx scripts/purge-non-admin.mts --apply --yes --stale   # + older orphans
 *
 * ===========================================================================
 * WHY THIS IS NOT "DELETE THE USERS COLLECTION"
 * ===========================================================================
 * Firestore has no foreign keys and no cascade. Emptying `users` from the
 * console leaves behind the three documents that actually enforce signup
 * uniqueness - `credentials/{userId}`, `usernames/{handle}` and the blocklist -
 * and registration then refuses addresses belonging to accounts that no longer
 * exist. That is the "registration is blocked" failure this script exists to
 * end permanently, and scripts/why-signup-blocked.mts diagnoses one address at
 * a time. See its header for the full explanation.
 *
 * So deletion here happens in four passes, in this order:
 *
 *   1. CLASSIFY.  Page `users`, split into KEEP (role in --keep-roles, ADMIN
 *                 by default) and DOOMED.
 *   2. OWNED.     For each doomed id: the user document with its subcollections
 *                 (followers, following, notificationPreferences, savedNotes),
 *                 every user-keyed document (credentials, wallets, mfa, ...),
 *                 and every document in any app collection carrying one of the
 *                 OWNER_FIELDS set to that id.
 *   3. DANGLING.  Back-references held by SURVIVORS or by keyless collections:
 *                 an admin's follower edge keyed by a doomed user, a like on an
 *                 admin's post, `sessionSecrets/{sessionId}` whose session is
 *                 gone, and any `usernames` / `credentials` document whose
 *                 owner does not exist - including ones orphaned before today.
 *   4. EXTERNAL.  Optional: Storage objects and Cloudinary KYC images.
 *
 * ===========================================================================
 * WHY THE SWEEP IS BY FIELD, NOT BY A HARD-CODED MAP
 * ===========================================================================
 * A `collection -> field` table is the obvious design and it is the one that
 * rots: a collection added next month is simply missing from it, and the
 * orphan it leaves is invisible until a signup fails months later. Instead
 * every app collection is swept for every field name in OWNER_FIELDS. An
 * equality query against a field a collection does not have is served by the
 * automatic single-field index, costs nothing and returns nothing, so the
 * sweep is wrong only in the safe direction: a NEW OWNER FIELD NAME must be
 * added to OWNER_FIELDS, and the script prints the list it used so that gap is
 * visible in the report rather than silent.
 *
 * ===========================================================================
 * SAFETY
 * ===========================================================================
 *  - Nothing is written without BOTH --apply and --yes.
 *  - ADMIN is the only role kept by default. The dry run prints a role
 *    breakdown of what it is about to delete and calls out privileged roles
 *    (MODERATOR and friends) on their own line; --keep-roles A,B widens it.
 *  - Refuses to run when it would leave the database with NO administrator,
 *    unless --allow-no-admin is given. That is not a style rule: the app
 *    authenticates against credentials/{userId}, so zero admins means the
 *    admin surface can only be re-entered with scripts/bootstrap-admin.mts.
 *  - Reference catalogues (universities, faculties) are never touched;
 *    registration cannot work without them.
 *  - The BLOCKLIST is never touched. Its entries are bans on hashed
 *    identifiers and survive the account they were issued against BY DESIGN -
 *    that is the one refusal in the signup path that is not a bug.
 *  - Collections that are not recognised as application data are listed and
 *    skipped; confirm one with --include a,b.
 */
// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const apply = has('apply');
if (apply && !has('yes')) {
  console.error('\n  --apply deletes every non-admin account. Add --yes to confirm.\n');
  process.exit(1);
}
const withStorage = has('storage');
const withCloudinary = has('cloudinary');
const allowNoAdmin = has('allow-no-admin');

const { adminBucket, adminDb } = await import('../src/lib/firebase/admin.core');
const { COLLECTIONS, SUBCOLLECTIONS, STORAGE_PATHS } = await import(
  '../src/lib/firebase/collections'
);

const db = adminDb();
const PAGE = 500;
/** Firestore's ceiling for one batched write, and for one `in` clause is 30. */
const BATCH = 500;
const IN_CHUNK = 30;

const firstLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0];

/** Reference catalogues and permanent records: never deleted by this script. */
const KEEP_COLLECTIONS = new Set<string>([
  COLLECTIONS.universities,
  COLLECTIONS.faculties,
  // Bans outlive the banned account on purpose.
  COLLECTIONS.blocklist,
]);

/**
 * Collections this script is allowed to touch. Mirrors bootstrap-admin.mts:
 * the private ones outside COLLECTIONS have to be named, because missing one
 * is exactly how `sessionSecrets` outlived the sessions it belonged to.
 */
const APP_COLLECTIONS = new Set<string>([
  ...Object.values(COLLECTIONS),
  'credentials',
  'sessionSecrets',
  'rateLimits',
  ...(option('include') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
]);

/**
 * Every field name in the schema that holds a user id.
 *
 * Derived from the repositories; `userId` covers most of it, the rest are the
 * relationship collections that name both sides. Adding a new one is the only
 * maintenance this script needs.
 */
const OWNER_FIELDS = [
  'userId',
  'authorId',
  'ownerId',
  'actorId',
  'sellerId',
  'buyerId',
  'mentorId',
  'menteeId',
  'followerId',
  'createdById',
  'frozenById',
  // Moderation and reporting name both sides. Missing these left 41
  // moderationActions and 3 contentReports pointing at deleted accounts after
  // the first real run of this script.
  'targetId',
  'targetUserId',
  'targetAuthorId',
  'reporterId',
  'reportedById',
  'recipientId',
  'reviewedById',
  'decidedById',
  'moderatorId',
] as const;

/**
 * Collections whose user reference is POLYMORPHIC and discriminated by a type
 * field, so it can be resolved exactly rather than guessed.
 *
 * `moderationActions` is the case that forced this: its `targetId` is the
 * moderated user when `targetType` is 'user', and a note, a mentor application
 * or a verification case otherwise. Treating the field as always-a-user would
 * delete a note's moderation history because a note id is not a user id;
 * treating it as never-a-user leaves 23 'user' actions pointing at accounts
 * that no longer exist. The discriminator is what makes the third option -
 * being right - available.
 */
const DISCRIMINATED_USER_REFS = [
  { collection: COLLECTIONS.moderationActions, typeField: 'targetType', userType: 'user', idField: 'targetId' },
  { collection: COLLECTIONS.contentReports, typeField: 'targetType', userType: 'user', idField: 'targetId' },
] as const;

/**
 * The subset of OWNER_FIELDS that can ONLY ever hold a user id.
 *
 * `targetId` is the reason this second list exists. In `moderationActions` it
 * is the moderated USER; in `contentReports` it is the reported POST
 * (`contentReports/post__{postId}__{reporterId}`). The same field name means
 * two different things in two collections.
 *
 * That polymorphism is harmless for the doomed-set sweep - a post id can never
 * appear in a set of user ids, so matching it is impossible - but it is fatal
 * for the --stale sweep below, which deletes on "this id is NOT a live user".
 * Under that rule every content report would be deleted because a post id is
 * not a user id. So --stale is restricted to the fields here.
 */
const UNAMBIGUOUS_USER_FIELDS = [
  'userId',
  'authorId',
  'ownerId',
  'actorId',
  'sellerId',
  'buyerId',
  'menteeId',
  'followerId',
  'createdById',
  'reporterId',
  'reportedById',
  'targetAuthorId',
  'targetUserId',
  'moderatorId',
] as const;

/**
 * Collections whose DOCUMENT ID is the user id. These are deleted by key
 * rather than found by query - and `credentials` being one of them is the
 * whole point of the script.
 */
const USER_KEYED = [
  'credentials',
  COLLECTIONS.wallets,
  COLLECTIONS.mfa,
  COLLECTIONS.mentorApplications,
  COLLECTIONS.accountDeletionRequests,
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pages a query by document name, so an arbitrarily large collection fits. */
async function eachPage(
  base: FirebaseFirestore.Query,
  onPage: (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => void,
): Promise<void> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = base.orderBy('__name__').limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) return;
    onPage(snap.docs);
    if (snap.size < PAGE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

// A trailing comma on the type parameter: in a .mts file `<T>` alone parses
// as JSX, which is what TS7060 is complaining about.
const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Collected deletions, de-duplicated by path.
 *
 * Deliberately gathered before anything is written: the dry run and the real
 * run then execute the SAME analysis, so what the report promises is exactly
 * what --apply does. The set is document references only - no document data is
 * ever pulled over the wire (every query below uses .select()).
 */
const doomedDocs = new Map<string, FirebaseFirestore.DocumentReference>();
/** Parents deleted recursively, i.e. with their subcollections. */
const doomedTrees = new Map<string, FirebaseFirestore.DocumentReference>();
const tally = new Map<string, number>();

function mark(ref: FirebaseFirestore.DocumentReference, bucket: string) {
  if (doomedDocs.has(ref.path) || doomedTrees.has(ref.path)) return;
  doomedDocs.set(ref.path, ref);
  tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
}

function markTree(ref: FirebaseFirestore.DocumentReference, bucket: string) {
  doomedDocs.delete(ref.path);
  if (doomedTrees.has(ref.path)) return;
  doomedTrees.set(ref.path, ref);
  tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// 1. CLASSIFY
// ---------------------------------------------------------------------------

const keepIds = new Set<string>();
const doomedIds = new Set<string>();
/** role -> how many accounts with it are about to be deleted. */
const doomedByRole = new Map<string, number>();

/**
 * Which roles survive. ADMIN only, as specified.
 *
 * MODERATOR is NOT on this list, and that is worth stating rather than
 * discovering: a moderator is a privileged account, and this script deletes it
 * along with the students. The role breakdown below is printed for exactly
 * that reason - so the operator sees "1 MODERATOR" in the dry run rather than
 * finding out afterwards. `--keep-roles ADMIN,MODERATOR` widens it.
 */
const KEEP_ROLES = new Set(
  (option('keep-roles') ?? 'ADMIN')
    .split(',')
    .map((role) => role.trim().toUpperCase())
    .filter(Boolean),
);

await eachPage(db.collection(COLLECTIONS.users).select('role'), (docs) => {
  for (const doc of docs) {
    // Upper-cased string rather than the enum: a document written by an older
    // version of the app with an unexpected role must land in DOOMED rather
    // than crash the classification - but a role that should be KEPT must
    // never be missed over a casing difference.
    const role = String(doc.get('role') ?? 'UNKNOWN').toUpperCase();
    if (KEEP_ROLES.has(role)) {
      keepIds.add(doc.id);
    } else {
      doomedIds.add(doc.id);
      doomedByRole.set(role, (doomedByRole.get(role) ?? 0) + 1);
    }
  }
});

const roleBreakdown = [...doomedByRole]
  .sort((a, b) => b[1] - a[1])
  .map(([role, count]) => `${count} ${role}`)
  .join(', ');

console.log(
  `\n  ${keepIds.size + doomedIds.size} user document(s): ` +
    `${keepIds.size} kept (${[...KEEP_ROLES].join(', ')}), ${doomedIds.size} to delete` +
    `${roleBreakdown ? ` - ${roleBreakdown}` : ''}.`,
);

// A privileged account is the thing an operator did not picture when they
// reached for a script called "purge non-admin". Called out on its own line.
for (const role of ['MODERATOR', 'STAFF', 'SUPPORT']) {
  const count = doomedByRole.get(role);
  if (count) {
    console.log(
      `  NOTE: ${count} ${role} account(s) will be deleted. ` +
        `Keep them with --keep-roles ADMIN,${role}`,
    );
  }
}

if (!KEEP_ROLES.has('ADMIN') && !allowNoAdmin) {
  console.error(
    '\n  REFUSED: --keep-roles does not include ADMIN, so every administrator would be\n' +
      '  deleted. Add ADMIN to the list, or pass --allow-no-admin if that is intended.\n',
  );
  process.exit(1);
}

if (keepIds.size === 0 && !allowNoAdmin) {
  console.error(
    '\n  REFUSED: no ADMIN account exists, so this would empty `users` entirely and\n' +
      '  leave no way into the admin surface. Create one first:\n\n' +
      '    npx tsx scripts/bootstrap-admin.mts --email <you@example.com>\n\n' +
      '  Or pass --allow-no-admin if wiping every account is genuinely intended.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. OWNED - everything belonging to a doomed user
// ---------------------------------------------------------------------------

const doomedList = [...doomedIds];

// 2a. The account itself, with its subcollections. recursiveDelete() at apply
// time walks followers/, following/, notificationPreferences/ and savedNotes/.
for (const id of doomedList) {
  markTree(db.collection(COLLECTIONS.users).doc(id), 'users (with subcollections)');
}

// 2b. User-keyed documents. Existence is checked with getAll so the dry-run
// count is real rather than an upper bound; getAll takes up to 300 refs.
for (const collection of USER_KEYED) {
  const refs = doomedList.map((id) => db.collection(collection).doc(id));
  for (const group of chunk(refs, 300)) {
    const snaps = await db.getAll(...group, { fieldMask: [] });
    for (const snap of snaps) if (snap.exists) mark(snap.ref, collection);
  }
}

// 2c. The field sweep. Every app collection x every owner field.
const presentCollections = (await db.listCollections()).map((ref) => ref.id);
const sweptCollections: string[] = [];

for (const name of presentCollections) {
  if (KEEP_COLLECTIONS.has(name)) continue;
  if (name === COLLECTIONS.users) continue; // handled in 2a
  if (!APP_COLLECTIONS.has(name)) {
    console.log(`    skipped  ${name} (not a known application collection; --include to add)`);
    continue;
  }
  sweptCollections.push(name);

  for (const field of OWNER_FIELDS) {
    // `in` takes at most 30 values, so the doomed set is queried in chunks.
    for (const ids of chunk(doomedList, IN_CHUNK)) {
      await eachPage(db.collection(name).where(field, 'in', ids).select(), (docs) => {
        for (const doc of docs) mark(doc.ref, `${name} (${field})`);
      });
    }
  }
}

// 2d. Session secrets for the doomed sessions. Keyed by SESSION id, so they
// cannot be reached by an owner field - the sessions have to be read first,
// and this is the exact shape of the orphan that survived an earlier wipe.
const doomedSessionIds: string[] = [];
for (const ids of chunk(doomedList, IN_CHUNK)) {
  await eachPage(
    db.collection(COLLECTIONS.sessions).where('userId', 'in', ids).select(),
    (docs) => {
      for (const doc of docs) doomedSessionIds.push(doc.id);
    },
  );
}
for (const sessionId of doomedSessionIds) {
  mark(db.collection('sessionSecrets').doc(sessionId), 'sessionSecrets');
}

// ---------------------------------------------------------------------------
// 3. DANGLING - references held by survivors, and pre-existing orphans
// ---------------------------------------------------------------------------

/**
 * Follow edges on the surviving admins.
 *
 * The graph is stored twice (users/{a}/following/{b} and users/{b}/followers/{a}),
 * with the OTHER party as the document id - so an admin followed by a deleted
 * student keeps a follower edge that recursiveDelete on the student never
 * reaches. Left alone it inflates the admin's follower count forever.
 */
for (const adminId of keepIds) {
  for (const path of [SUBCOLLECTIONS.userFollowers(adminId), SUBCOLLECTIONS.userFollowing(adminId)]) {
    await eachPage(db.collection(path).select(), (docs) => {
      for (const doc of docs) if (doomedIds.has(doc.id)) mark(doc.ref, 'follow edges (survivors)');
    });
  }
}

/**
 * Likes left on surviving posts.
 *
 * `posts/{id}/likes/{userId}` is keyed by the liker, so the same problem: the
 * post survives (an admin wrote it), the liker does not. A collection-group
 * query reaches every likes subcollection in one sweep; posts that are
 * themselves doomed are deleted as trees, so their likes go with them.
 */
await (async () => {
  try {
    const doomedPostPaths = new Set(
      [...doomedDocs.values(), ...doomedTrees.values()]
        .filter((ref) => ref.parent.id === COLLECTIONS.posts)
        .map((ref) => ref.path),
    );
    await eachPage(db.collectionGroup('likes').select(), (docs) => {
      for (const doc of docs) {
        if (!doomedIds.has(doc.id)) continue;
        if (doc.ref.parent.parent && doomedPostPaths.has(doc.ref.parent.parent.path)) continue;
        mark(doc.ref, 'likes (surviving posts)');
      }
    });
  } catch (error) {
    // A collection-group scan needs no composite index, but a project with
    // single-field indexing disabled for `likes` would refuse it. Report it
    // rather than aborting a purge that is otherwise complete.
    console.log(`    likes    collection-group sweep skipped: ${firstLine(error)}`);
  }
})();

/**
 * --stale: references whose owner is not merely being deleted TODAY, but is
 * already gone.
 *
 * The field sweep in step 2 matches `field IN doomedIds`, so it only ever
 * finds references to the accounts this run is deleting. A reference left by
 * an EARLIER wipe names an id that is in no set at all, and no query can ask
 * Firestore for "not in the live users" - so the only way to find these is to
 * read the collection and check each value against the live set.
 *
 * That is a full read of every app collection, which is why it is opt-in
 * rather than part of the default run. Restricted to UNAMBIGUOUS_USER_FIELDS;
 * see the comment there for why `targetId` must not be included.
 */
if (has('stale')) {
  // Checked against the SURVIVORS, not against every user document that
  // currently exists: the doomed accounts are being deleted in this same run,
  // so a reference to one is stale the moment the run commits.
  const survivors = keepIds;

  // The discriminated references first: same "owner is gone" rule, but the
  // field only counts as a user reference when its type field says so.
  for (const spec of DISCRIMINATED_USER_REFS) {
    if (!sweptCollections.includes(spec.collection)) continue;
    await eachPage(db.collection(spec.collection), (docs) => {
      for (const doc of docs) {
        if (String(doc.get(spec.typeField) ?? '') !== spec.userType) continue;
        const value = doc.get(spec.idField);
        if (typeof value !== 'string' || !value || survivors.has(value)) continue;
        mark(doc.ref, `${spec.collection} (${spec.idField}=user, stale)`);
      }
    });
  }

  for (const name of sweptCollections) {
    await eachPage(db.collection(name), (docs) => {
      for (const doc of docs) {
        const data = doc.data();
        for (const field of UNAMBIGUOUS_USER_FIELDS) {
          const value = data[field];
          if (typeof value !== 'string' || !value) continue;
          if (survivors.has(value)) continue;
          mark(doc.ref, `${name} (${field}, stale)`);
          break;
        }
      }
    });
  }
}

/**
 * Pre-existing orphans: a `usernames` claim or a `credentials` document whose
 * owner is already missing. These predate this run - they are the leftovers of
 * whatever emptied `users` before - and they refuse a handle or an address
 * with no account behind it. Clearing them is the point of the exercise.
 */
const liveUserIds = new Set<string>([...keepIds, ...doomedIds]);

await eachPage(db.collection(COLLECTIONS.usernames).select('userId'), (docs) => {
  for (const doc of docs) {
    const owner = String(doc.get('userId') ?? '');
    if (!owner || doomedIds.has(owner) || !liveUserIds.has(owner)) {
      mark(doc.ref, 'usernames (claim released)');
    }
  }
});

await eachPage(db.collection('credentials').select(), (docs) => {
  for (const doc of docs) {
    if (!liveUserIds.has(doc.id)) mark(doc.ref, 'credentials (orphaned)');
  }
});

// Sessions and their secrets whose user is already gone.
const liveSessionIds = new Set<string>();
await eachPage(db.collection(COLLECTIONS.sessions).select('userId'), (docs) => {
  for (const doc of docs) {
    liveSessionIds.add(doc.id);
    if (!liveUserIds.has(String(doc.get('userId') ?? ''))) mark(doc.ref, 'sessions (orphaned)');
  }
});
await eachPage(db.collection('sessionSecrets').select(), (docs) => {
  for (const doc of docs) {
    if (!liveSessionIds.has(doc.id)) mark(doc.ref, 'sessionSecrets (orphaned)');
  }
});

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

const total = doomedDocs.size + doomedTrees.size;

console.log(`\n  Swept ${sweptCollections.length} collection(s) for [${OWNER_FIELDS.join(', ')}].`);
console.log(`  Kept: universities, faculties, blocklist (bans outlive their accounts).\n`);

for (const [bucket, count] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(6)}  ${bucket}`);
}

if (total === 0) {
  console.log('\n  Nothing to delete.\n');
  process.exit(0);
}

if (!apply) {
  console.log(
    `\n  ${total} document(s) (plus the subcollections under ${doomedTrees.size} user tree(s))` +
      `\n  would be deleted. Re-run with --apply --yes.\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------

console.log('\n  Deleting');

/**
 * Trees first, flat documents second.
 *
 * The order matters for interruption: killing the process halfway leaves
 * credentials and username claims still pointing at users that are gone, which
 * why-signup-blocked.mts --orphans --apply can finish, and which a re-run of
 * THIS script also finishes (step 3 finds them). The reverse order would leave
 * the account documents behind with their claims released - a live user who
 * cannot log in, and whose handle someone else can now take.
 */
let treesDeleted = 0;
for (const ref of doomedTrees.values()) {
  await db.recursiveDelete(ref);
  treesDeleted += 1;
  if (treesDeleted % 100 === 0) console.log(`    users    ${treesDeleted}/${doomedTrees.size}`);
}
console.log(`    users    ${treesDeleted} account tree(s) deleted`);

let flatDeleted = 0;
for (const group of chunk([...doomedDocs.values()], BATCH)) {
  const batch = db.batch();
  for (const ref of group) batch.delete(ref);
  await batch.commit();
  flatDeleted += group.length;
}
console.log(`    docs     ${flatDeleted} document(s) deleted`);

// ---------------------------------------------------------------------------
// 4. EXTERNAL - opt-in, because neither is transactional with Firestore
// ---------------------------------------------------------------------------

/**
 * Storage. NOTHING here is addressable by user id - note files are keyed by
 * note id and post media by asset id - so objects are deleted from the ids the
 * Firestore sweep already collected, never by a prefix wipe. A prefix wipe
 * would take an admin's own note with it.
 */
if (withStorage) {
  // Avatars need no case of their own: an avatar IS a mediaAsset owned by the
  // user (see /api/me/avatar), so it is already in the mediaAssets list below.
  const noteIds = [...doomedDocs.keys()]
    .filter((path) => path.startsWith(`${COLLECTIONS.notes}/`))
    .map((path) => path.split('/')[1]);
  let notePrefixes = 0;
  for (const noteId of noteIds) {
    try {
      await adminBucket().deleteFiles({ prefix: `notes/${noteId}/`, force: true });
      notePrefixes += 1;
    } catch (error) {
      console.log(`    storage  notes/${noteId}/ skipped: ${firstLine(error)}`);
    }
  }
  console.log(`    storage  ${notePrefixes} note prefix(es) cleared`);

  const assetIds = [...doomedDocs.keys()]
    .filter((path) => path.startsWith(`${COLLECTIONS.mediaAssets}/`))
    .map((path) => path.split('/')[1]);
  let media = 0;
  for (const assetId of assetIds) {
    try {
      await adminBucket().file(STORAGE_PATHS.postMedia(assetId)).delete({ ignoreNotFound: true });
      media += 1;
    } catch (error) {
      console.log(`    storage  media ${assetId} skipped: ${firstLine(error)}`);
    }
  }
  console.log(`    storage  ${media} media object(s) cleared`);
}

/**
 * Cloudinary KYC images.
 *
 * Under the zero-retention policy these are already deleted within the review
 * window, so this is a backstop for a review that was abandoned mid-flight -
 * and a prefix wipe is safe because an ADMIN never submits a verification
 * document. That assumption is stated because it is the only thing keeping
 * this from being a per-case deletion.
 */
if (withCloudinary) {
  try {
    const { cloudinaryClient } = await import('../src/lib/cloudinary/server');
    const result = await cloudinaryClient().api.delete_resources_by_prefix(
      'campushub/kyc-review/',
      { type: 'authenticated', resource_type: 'image' },
    );
    console.log(
      `    cloudinary campushub/kyc-review/ (${Object.keys(result.deleted ?? {}).length} assets)`,
    );
  } catch (error) {
    console.log(`    cloudinary skipped: ${firstLine(error)}`);
  }
}

console.log(
  `\n  Done. ${keepIds.size} account(s) remain (${[...KEEP_ROLES].join(', ')}).\n` +
    `  Verify registration is unblocked:  npx tsx scripts/why-signup-blocked.mts --orphans\n`,
);
