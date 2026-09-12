/**
 * Resets CampusHub to a clean state and creates exactly one administrator.
 *
 *   npx tsx scripts/bootstrap-admin.mts --email admin@campushub.az            # admin only
 *   npx tsx scripts/bootstrap-admin.mts --email admin@campushub.az --wipe --yes
 *
 * --wipe deletes APPLICATION data only:
 *   - every Firestore collection the app owns (and their subcollections),
 *     EXCEPT the reference catalogues registration depends on (universities,
 *     faculties). Collections the app does not own are listed and left alone.
 *   - the app's Firebase Storage prefixes (notes/, media/, avatars/, kyc-review/)
 *   - leftover Firebase Auth accounts (the app authenticates against
 *     credentials/{userId}, never Firebase Auth)
 *   - Cloudinary verification images under campushub/kyc-review/
 * Project configuration, rules, indexes and other resources are never touched.
 *
 * --wipe REFUSES to run while an ADMIN exists unless --replace-admin is also
 * given: wiping deletes that admin and this script then issues a brand-new
 * password, which silently invalidates the one the operator saved. Re-running
 * the command from shell history must never do that by accident.
 *
 * The password is generated here, printed ONCE, and stored only as an argon2id
 * hash in credentials/{userId}. Rotate it with scripts/reset-admin-password.mts;
 * check a candidate without a login attempt with scripts/check-admin-password.mts.
 */
import { randomBytes } from 'node:crypto';
// Loads .env* the same way Next.js does, before any Firebase module.
import '../src/server/load-env';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const email = (option('email') ?? '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(
    '\n  Usage: npx tsx scripts/bootstrap-admin.mts --email <email> [--wipe --yes [--replace-admin]]\n',
  );
  process.exit(1);
}
const wipe = flag('wipe');
if (wipe && !flag('yes')) {
  console.error('\n  --wipe deletes all application data. Add --yes to confirm.\n');
  process.exit(1);
}

const { adminAuth, adminBucket, adminDb } = await import('../src/lib/firebase/admin.core');
const { COLLECTIONS } = await import('../src/lib/firebase/collections');
const { forFirestore } = await import('../src/lib/firebase/convert');
const { hashEmail, hashPassword } = await import('../src/lib/crypto/hash');

const db = adminDb();
const users = db.collection(COLLECTIONS.users);
const firstLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0];

/** Reference catalogues, not user data: registration cannot work without them. */
const KEEP = new Set<string>([COLLECTIONS.universities, COLLECTIONS.faculties]);
const APP_COLLECTIONS = new Set<string>([
  ...Object.values(COLLECTIONS),
  // Private collections outside COLLECTIONS. Missing one leaves orphans:
  // sessionSecrets survived an earlier wipe that deleted its sessions.
  'credentials',
  'sessionSecrets',
  'rateLimits',
  // --include a,b: extra collections the operator has confirmed are app data.
  ...(option('include') ?? '').split(',').map((name) => name.trim()).filter(Boolean),
]);
const STORAGE_PREFIXES = ['notes/', 'media/', 'avatars/', 'kyc-review/'];

const existingAdmin = await users.where('role', '==', 'ADMIN').limit(1).get();

if (wipe && !existingAdmin.empty && !flag('replace-admin')) {
  const admin = existingAdmin.docs[0].data();
  console.error(
    `\n  An ADMIN already exists (${admin.email}). --wipe would delete it and issue a NEW\n` +
      '  password, invalidating the one you saved. Nothing was changed.\n\n' +
      '  - Forgot the password?   npx tsx scripts/reset-admin-password.mts <email> <new-password>\n' +
      '  - Check a password?      npx tsx scripts/check-admin-password.mts <email>\n' +
      '  - Really start over?     re-run with --replace-admin\n',
  );
  process.exit(1);
}

if (wipe) {
  console.log('\n  Wiping application data');

  for (const ref of await db.listCollections()) {
    if (KEEP.has(ref.id)) {
      console.log(`    kept     ${ref.id} (reference data)`);
      continue;
    }
    if (!APP_COLLECTIONS.has(ref.id)) {
      console.log(`    skipped  ${ref.id} (not an application collection)`);
      continue;
    }
    const count = (await ref.count().get()).data().count;
    await db.recursiveDelete(ref);
    console.log(`    wiped    ${ref.id} (${count} docs, with subcollections)`);
  }

  for (const prefix of STORAGE_PREFIXES) {
    try {
      const [files] = await adminBucket().getFiles({ prefix });
      if (files.length) await adminBucket().deleteFiles({ prefix, force: true });
      console.log(`    storage  ${prefix} (${files.length} objects)`);
    } catch (error) {
      console.log(`    storage  ${prefix} skipped: ${firstLine(error)}`);
    }
  }

  try {
    let removed = 0;
    let pageToken: string | undefined;
    do {
      const page = await adminAuth().listUsers(1000, pageToken);
      if (page.users.length) {
        removed += (await adminAuth().deleteUsers(page.users.map((u) => u.uid))).successCount;
      }
      pageToken = page.pageToken;
    } while (pageToken);
    console.log(`    auth     ${removed} Firebase Auth account(s) removed`);
  } catch (error) {
    console.log(`    auth     skipped: ${firstLine(error)}`);
  }

  try {
    const { cloudinaryClient } = await import('../src/lib/cloudinary/server');
    const result = await cloudinaryClient().api.delete_resources_by_prefix('campushub/kyc-review/', {
      type: 'authenticated',
      resource_type: 'image',
    });
    console.log(`    cloudinary campushub/kyc-review/ (${Object.keys(result.deleted ?? {}).length} assets)`);
  } catch (error) {
    console.log(`    cloudinary skipped: ${firstLine(error)}`);
  }
} else if (!existingAdmin.empty) {
  console.error('\n  An ADMIN account already exists. Use scripts/reset-admin-password.mts instead.\n');
  process.exit(1);
}

if (!(await users.where('email', '==', email).limit(1).get()).empty) {
  console.error('\n  An account with that email already exists.\n');
  process.exit(1);
}

/**
 * 24 unbiased characters from an alphanumeric alphabet (~140 bits), always
 * with upper, lower and digit.
 *
 * Alphanumeric on purpose: terminals treat ! @ # % * - = + as word
 * separators, so double-clicking a password containing them copies only a
 * fragment - a correct password that "does not work". Look-alikes (0/O, 1/l/I)
 * are excluded for the same reason.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const limit = 256 - (256 % alphabet.length);
  for (;;) {
    let out = '';
    while (out.length < 24) {
      const byte = randomBytes(1)[0];
      if (byte < limit) out += alphabet[byte % alphabet.length];
    }
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /\d/.test(out)) return out;
  }
}

const password = generatePassword();
const passwordHash = await hashPassword(password);
const ref = users.doc();
const now = new Date();

// Same document shape the app writes on registration (see scripts/seed-e2e.mts):
// every optional field an explicit null, so `where(field, '==', null)` matches.
const batch = db.batch();
batch.set(
  ref,
  forFirestore({
    email,
    fullName: 'CampusHub Admin',
    firstName: null,
    lastName: null,
    dateOfBirth: null,
    nickname: 'admin',
    nicknameLower: 'admin',
    avatarUrl: null,
    headline: null,
    bio: null,
    locale: 'az',
    timezone: 'Asia/Baku',
    role: 'ADMIN',
    accountStatus: 'ACTIVE',
    universityId: null,
    facultyId: null,
    facultySlug: null,
    facultyOther: null,
    studentNumber: null,
    department: null,
    academicTitle: null,
    verificationStatus: 'VERIFIED',
    isVerified: true,
    verifiedAt: now,
    studentStatusConfirmed: false,
    identityConfirmed: true,
    graduationYear: null,
    graduationMonth: null,
    alumniTransitionedAt: null,
    graduationPromptedAt: null,
    phone: null,
    frozenUntil: null,
    frozenReason: null,
    frozenById: null,
    frozenAt: null,
    showRealName: 'PRIVATE',
    showEmail: 'PRIVATE',
    showPhone: 'PRIVATE',
    showUniversity: 'PRIVATE',
    showFaculty: 'PRIVATE',
    failedLoginCount: 0,
    lockedUntil: null,
    emailVerifiedAt: now,
    lastLoginAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }),
);
batch.set(
  db.collection('credentials').doc(ref.id),
  forFirestore({ passwordHash, emailHash: hashEmail(email), phoneHash: null, updatedAt: now }),
);
batch.set(
  db.collection(COLLECTIONS.wallets).doc(ref.id),
  forFirestore({
    userId: ref.id,
    currency: 'AZN',
    availableMinor: 0,
    pendingMinor: 0,
    version: 0,
    isFrozen: false,
    createdAt: now,
  }),
);
batch.set(
  db.collection(COLLECTIONS.auditLogs).doc(),
  forFirestore({
    actorId: ref.id,
    action: 'ADMIN_BOOTSTRAP_CLI',
    entityType: 'user',
    entityId: ref.id,
    result: 'SUCCESS',
    before: null,
    after: { method: 'operator cli', wiped: wipe },
    deviceFingerprint: null,
    userAgent: null,
    ip: null,
    createdAt: now,
  }),
);
await batch.commit();

console.log(`\n  Admin account created ${now.toISOString()}`);
console.log(`    id:     ${ref.id}`);
console.log(`    email:  ${email}`);
console.log('    password (the whole next line, nothing else):\n');
console.log(password);
console.log('\n  Shown once - store it in a password manager. Any earlier admin password is void.\n');
process.exit(0);
