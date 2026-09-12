// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';
/**
 * Resets one account's password from the command line.
 *
 *   npx tsx scripts/reset-admin-password.mts <email> <new-password>
 *
 * There is deliberately no "recover my password" path in the product, and this
 * script is not one either - it SETS a new password, it cannot reveal the old
 * one. Passwords are stored as Argon2id hashes, which are designed to be
 * irreversible; if this script could tell you the previous password, that
 * would be a defect in the storage scheme rather than a convenience.
 *
 * Operator-only, run with the Firebase Admin credentials the operator already
 * holds. It writes an audit row so a password change made out of band is still
 * visible in the log, exactly like one made through the app.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IMPORTS ./admin.core AND NOT ./admin
 * ---------------------------------------------------------------------------
 * `src/lib/firebase/admin.ts` starts with `import 'server-only'`, which throws
 * unconditionally outside Next's bundler - so a plain `tsx` script cannot load
 * it. The implementation lives in admin.core for exactly this reason; see its
 * header.
 */
import { hashPassword } from '../src/lib/crypto/hash';
import { adminDb } from '../src/lib/firebase/admin.core';
import { COLLECTIONS } from '../src/lib/firebase/collections';

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('\n  Usage: npx tsx scripts/reset-admin-password.mts <email> <new-password>\n');
  process.exit(1);
}

// Mirrors the registration rule in src/server/validators/auth.ts: length-first,
// no composition theatre. Enforced here too, so an operator cannot quietly set
// a weaker password than the signup form would have accepted.
if (password.length < 12 || new Set(password).size < 5) {
  console.error('\n  Password must be at least 12 characters with at least 5 distinct ones.\n');
  process.exit(1);
}

const db = adminDb();

const snap = await db
  .collection(COLLECTIONS.users)
  .where('email', '==', email.trim().toLowerCase())
  .limit(1)
  .get();

if (snap.empty) {
  console.error('\n  No account with that email.\n');
  process.exit(1);
}

const doc = snap.docs[0];
const user = doc.data() as {
  nickname: string;
  role: string;
  deletedAt: unknown;
};

if (user.deletedAt) {
  console.error('\n  That account is deleted. Restore it before setting a password.\n');
  process.exit(1);
}

const passwordHash = await hashPassword(password);
const now = new Date();

/**
 * The hash goes to `credentials/{id}`, NOT to the user document.
 *
 * That split is the whole reason it exists: Firestore grants are per document,
 * so "this user may read their own profile" would otherwise mean "may read
 * their own password hash". See the header of the users repository.
 */
await db
  .collection('credentials')
  .doc(doc.id)
  .set({ passwordHash, updatedAt: now }, { merge: true });

// A forgotten password often means a lockout is already in force from failed
// attempts. Clearing both is the point of the reset.
await db
  .collection(COLLECTIONS.users)
  .doc(doc.id)
  .update({ failedLoginCount: 0, lockedUntil: null, updatedAt: now });

/**
 * Every existing session is revoked.
 *
 * A password reset that leaves old sessions alive does not actually take
 * anything back - whoever held the account before still holds it. This is also
 * why requireSession() checks the session document on every request: the
 * revocation below is effective immediately, not when a token expires.
 *
 * Chunked because an account can accumulate more sessions than the 500-write
 * batch ceiling allows.
 */
const sessions = await db
  .collection(COLLECTIONS.sessions)
  .where('userId', '==', doc.id)
  .where('revokedAt', '==', null)
  .get();

for (let i = 0; i < sessions.docs.length; i += 400) {
  const batch = db.batch();
  for (const session of sessions.docs.slice(i, i + 400)) {
    batch.update(session.ref, { revokedAt: now });
  }
  await batch.commit();
}

await db.collection(COLLECTIONS.auditLogs).add({
  actorId: doc.id,
  action: 'USER_PASSWORD_RESET_CLI',
  entityType: 'user',
  entityId: doc.id,
  result: 'SUCCESS',
  // The password itself is never written anywhere but the credentials hash.
  after: { method: 'operator cli', sessionsRevoked: sessions.size },
  before: null,
  deviceFingerprint: null,
  userAgent: null,
  ip: null,
  createdAt: now,
});

console.log(`\n  Password updated for @${user.nickname} (${user.role})`);
console.log(`  ${sessions.size} session(s) revoked - sign in again.\n`);

// The account owner is told on their registered address.
const { sendEmail } = await import('../src/lib/email/send');
const mail = await sendEmail(email.trim().toLowerCase(), 'passwordReset', { nickname: user.nickname });
console.log(mail.ok ? '  Notification email: ' + (mail.skipped ?? 'sent') + '\n' : '  Notification email failed: ' + mail.error + '\n');
process.exit(0);
