// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';

/**
 * Refuses to create test accounts in the live project. This script (and the
 * e2e suite) is what kept producing the e2e.* / repro* accounts once scripts
 * could reach the real Firestore. Run it against the emulator, or opt in
 * deliberately with E2E_ALLOW_LIVE_DB=1.
 */
if (!process.env.FIRESTORE_EMULATOR_HOST && process.env.E2E_ALLOW_LIVE_DB !== '1') {
  console.error(
    '\n  Refusing to create test accounts in the live Firestore project.\n' +
      '  Use the emulator (FIRESTORE_EMULATOR_HOST) or set E2E_ALLOW_LIVE_DB=1 deliberately.\n',
  );
  process.exit(1);
}
/**
 * Seeds the fixtures the browser suite needs. Safe to re-run.
 *
 *   npx tsx scripts/seed-e2e.mts
 *
 * Creates four test accounts, an approved mentor profile with availability,
 * and one freshly PUBLISHED priced note for the purchase test.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NOTE IS NEW EVERY RUN INSTEAD OF BEING RESET
 * ---------------------------------------------------------------------------
 * A purchase cannot be undone. The ledger is append-only by policy and by the
 * security rules, which deny update and delete on ledgerTransactions and
 * ledgerEntries outright - which is the correct design for money, and is why
 * an attempt to "reset" a previous purchase has nowhere to go.
 *
 * So the fixture adapts to the invariant rather than fighting it: each run gets
 * its own note, and the purchase test buys something nobody has bought. Orders
 * from previous runs are left exactly where they are, which is also what makes
 * the purchases page accumulate realistic history.
 *
 * ---------------------------------------------------------------------------
 * IT IMPORTS ./admin.core, NOT ./admin
 * ---------------------------------------------------------------------------
 * `admin.ts` starts with `import 'server-only'`, which throws outside Next's
 * bundler, so a `tsx` script cannot load it. See that file's header.
 */
import { createHash } from 'node:crypto';
import { hashPassword, hashEmail, hashPhone } from '../src/lib/crypto/hash';
import { adminDb, adminBucket } from '../src/lib/firebase/admin.core';
import { COLLECTIONS, SUBCOLLECTIONS, STORAGE_PATHS } from '../src/lib/firebase/collections';
import { forFirestore } from '../src/lib/firebase/convert';
import { seal } from '../src/lib/crypto/vault';
import { base32Decode } from '../src/lib/auth/totp';

/** Test-only authenticator key for the moderator fixture. Must match scripts/e2e.mjs. */
const E2E_TOTP_DEFAULT = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const db = adminDb();
const PASSWORD = process.env.E2E_PASSWORD ?? 'UniPathTest2026!';

const PEOPLE: {
  email: string;
  nickname: string;
  role: string;
  verification: string;
  phone: string;
}[] = [
  { email: 'e2e.student@ada.edu.az', nickname: 'e2estudent', role: 'STUDENT', verification: 'VERIFIED', phone: '+994501110001' },
  { email: 'e2e.unverified@ada.edu.az', nickname: 'e2eunverif', role: 'STUDENT', verification: 'UNVERIFIED', phone: '+994501110002' },
  { email: 'e2e.mod@ada.edu.az', nickname: 'e2emod', role: 'MODERATOR', verification: 'VERIFIED', phone: '+994501110003' },
  { email: 'e2e.frozen@ada.edu.az', nickname: 'e2efrozen', role: 'STUDENT', verification: 'VERIFIED', phone: '+994501110004' },
];

const uniSnap = await db.collection(COLLECTIONS.universities).where('code', '==', 'ADA').limit(1).get();
const universityId = uniSnap.empty ? null : uniSnap.docs[0].id;

const passwordHash = await hashPassword(PASSWORD);
const ids = new Map<string, string>();

for (const person of PEOPLE) {
  /**
   * Upsert by EMAIL, not by a derived document id.
   *
   * The application mints random ids for users, so a re-run cannot address an
   * existing account by construction - it has to look it up. Reusing the found
   * id is what keeps this script idempotent: without it, every run would build
   * a fresh account and the suite would drift away from the data it asserts on.
   */
  const existing = await db
    .collection(COLLECTIONS.users)
    .where('email', '==', person.email)
    .limit(1)
    .get();

  const ref = existing.empty ? db.collection(COLLECTIONS.users).doc() : existing.docs[0].ref;
  const now = new Date();

  await ref.set(
    forFirestore({
      email: person.email,
      // No digits: the name validator rejects them, because a name on an ID
      // document does not contain any. A fixture that violates the rule tests
      // the wrong path.
      fullName: 'Test Student',
      firstName: null,
      lastName: null,
      dateOfBirth: null,
      nickname: person.nickname,
      nicknameLower: person.nickname.toLowerCase(),
      avatarUrl: null,
      headline: null,
      bio: null,
      locale: 'az',
      timezone: 'Asia/Baku',
      role: person.role,
      accountStatus: 'ACTIVE',
      universityId,
      facultyId: null,
      facultySlug: 'computer-science',
      facultyOther: null,
      department: null,
      academicTitle: null,
      verificationStatus: person.verification,
      isVerified: person.verification === 'VERIFIED',
      verifiedAt: person.verification === 'VERIFIED' ? now : null,
      studentStatusConfirmed: person.verification === 'VERIFIED',
      identityConfirmed: person.verification === 'VERIFIED',
      graduationYear: 2027,
      graduationMonth: 6,
      alumniTransitionedAt: null,
      graduationPromptedAt: null,
      phone: person.phone,
      frozenUntil: null,
      frozenReason: null,
      frozenById: null,
      frozenAt: null,
      showRealName: 'PRIVATE',
      showEmail: 'PRIVATE',
      showPhone: 'PRIVATE',
      showUniversity: 'PUBLIC',
      showFaculty: 'PUBLIC',
      showGraduationYear: 'VERIFIED_ONLY',
      failedLoginCount: 0,
      lockedUntil: null,
      emailVerifiedAt: now,
      lastLoginAt: null,
      /**
       * Every optional field is written as an explicit null rather than
       * omitted. Firestore cannot match a document on a field it does not
       * have, so a fixture with a missing `deletedAt` would be invisible to
       * every `where('deletedAt', '==', null)` the app runs - which is most of
       * them.
       */
      deletedAt: null,
      createdAt: existing.empty ? now : existing.docs[0].data().createdAt ?? now,
      updatedAt: now,
    }),
  );

  // The credential document, kept out of the profile so that "may read this
  // user" never means "may read their password hash".
  await db
    .collection('credentials')
    .doc(ref.id)
    .set(
      forFirestore({
        passwordHash,
        emailHash: hashEmail(person.email),
        phoneHash: hashPhone(person.phone),
        updatedAt: now,
      }),
    );

  // The username claim createUser() writes, so login by @handle works for the
  // fixtures too. set() is safe here: the handle and the id are both this
  // fixture's, and a re-run must converge rather than fail.
  await db
    .collection(COLLECTIONS.usernames)
    .doc(person.nickname.toLowerCase())
    .set(forFirestore({ userId: ref.id, createdAt: now }));


  ids.set(person.email, ref.id);
  console.log(`  ${person.role.padEnd(10)} ${person.email.padEnd(28)} @${person.nickname}`);
}

/**
 * The moderator fixture has two-factor authentication, because staff sessions
 * without it carry no staff role (see requireSession). The secret is a KNOWN
 * test value - E2E_TOTP_SECRET, base32, the same variable scripts/e2e.mjs
 * reads to answer the code prompt - which is acceptable only because this
 * script refuses the live project unless E2E_ALLOW_LIVE_DB=1 is set on purpose.
 * Written sealed, exactly as confirmEnrollment() stores it.
 */
{
  const modId = ids.get('e2e.mod@ada.edu.az')!;
  const secret = base32Decode(process.env.E2E_TOTP_SECRET ?? E2E_TOTP_DEFAULT);
  const now = new Date();
  await db.collection(COLLECTIONS.mfa).doc(modId).set(
    forFirestore({
      totpSecretSealed: seal(secret, { userId: modId, purpose: 'totp' }),
      enrolledAt: now,
      pendingSecretSealed: null,
      pendingCreatedAt: null,
      lastUsedStep: 0,
      recoveryCodeHashes: [],
      failedCount: 0,
      lockedUntil: null,
      updatedAt: now,
    }),
  );
  console.log('  MODERATOR  2FA enrolled with E2E_TOTP_SECRET');
}

const sellerId = ids.get('e2e.student@ada.edu.az')!;
const frozenId = ids.get('e2e.frozen@ada.edu.az')!;

// One account is left frozen so the enforcement path has something to test.
await db.collection(COLLECTIONS.users).doc(frozenId).update(
  forFirestore({
    accountStatus: 'SUSPENDED',
    frozenUntil: new Date(Date.now() + 86_400_000),
    frozenReason: 'E2E freeze fixture',
    frozenAt: new Date(),
  }),
);


/**
 * The mentor profile is keyed by the mentor's USER id.
 *
 * `MentorProfile.userId` carried a UNIQUE constraint, giving one profile per
 * account. Firestore has no unique index, so the constraint is expressed
 * structurally instead - and it makes this fixture idempotent for free.
 */
const mentorId = sellerId;
await db.collection(COLLECTIONS.mentorProfiles).doc(mentorId).set(
  forFirestore({
    userId: sellerId,
    industry: 'IT',
    specialties: ['Interviews', 'Career', 'Backend'],
    headline: 'Backend engineer helping students land their first internship',
    about:
      'I have mentored 20+ students through technical interviews.\nHappy to review CVs and run mock interviews.',
    company: 'Test Co',
    jobTitle: 'Senior Engineer',
    yearsExperience: 6,
    linkedinUrl: null,
    languages: ['az', 'en'],
    hourlyRateMinor: 2500,
    sessionMinutes: 45,
    bufferMinutes: 15,
    minNoticeHours: 12,
    timezone: 'Asia/Baku',
    isApproved: true,
    approvedAt: new Date(),
    isAcceptingBookings: true,
    ratingAvg: 0,
    ratingCount: 0,
    sessionsCompleted: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
);

// Availability rules are keyed by weekday, so a re-run replaces them in place
// rather than accumulating five more every time.
for (const rule of [
  { weekday: 1, startMinute: 540, endMinute: 720 },
  { weekday: 2, startMinute: 540, endMinute: 720 },
  { weekday: 3, startMinute: 600, endMinute: 780 },
  { weekday: 4, startMinute: 600, endMinute: 780 },
  { weekday: 5, startMinute: 540, endMinute: 720 },
]) {
  await db
    .collection(SUBCOLLECTIONS.availability(mentorId))
    .doc(`weekday-${rule.weekday}`)
    .set(forFirestore({ ...rule, validFrom: null, validUntil: null }));
}

/**
 * A fresh shared note, tagged with the run's timestamp so the suite can find
 * the one this run created. Notes are free: any signed-in account downloads it.
 */
const stamp = Date.now();
const bytes = Buffer.from(`E2E shared note ${stamp}.\n`.repeat(40));
const sha = createHash('sha256').update(bytes).digest('hex');

const noteRef = db.collection(COLLECTIONS.notes).doc();
const storagePath = STORAGE_PATHS.noteFile(noteRef.id, 'e2e-note.txt');

// Bytes first, document second - the same ordering createNote() uses, and for
// the same reason: an orphaned object is harmless, a note whose file is
// missing 404s for everyone who opens it.
await adminBucket().file(storagePath).save(bytes, { contentType: 'text/plain' });

await noteRef.set(
  forFirestore({
    sellerId,
    title: `E2E shared note ${stamp}`,
    description: 'A note created by scripts/seed-e2e.mts for the notes test.',
    subject: 'Testing',
    courseCode: null,
    academicYear: null,
    universityId,
    language: 'en',
    status: 'PUBLISHED',
    publishedAt: new Date(),
    fileKey: storagePath,
    fileSha256: sha,
    sizeBytes: bytes.length,
    pageCount: null,
    previewKey: null,
    downloadCount: 0,
    ratingAvg: 0,
    ratingCount: 0,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachment: {
      fileName: 'e2e-note.txt',
      mime: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha,
      storagePath,
    },
  }),
);

console.log(`\n  mentor profile : ${mentorId}`);
console.log(`  purchasable    : ${noteRef.id} ("E2E shared note ${stamp}")`);
console.log(`  password       : ${PASSWORD}\n`);
