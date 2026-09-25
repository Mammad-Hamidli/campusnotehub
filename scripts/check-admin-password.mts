/**
 * Checks a password against an account's stored argon2id hash - WITHOUT a
 * login attempt, so it never increments failedLoginCount or trips the lockout.
 *
 *   npx tsx scripts/check-admin-password.mts admin@campusnotehub.com
 *
 * The password is read from a hidden prompt, never from argv (argv lands in
 * shell history). Read-only: nothing in Firestore is modified. It needs the
 * service account, which already grants full database access, so it adds no
 * capability an operator did not have.
 */
import { createInterface } from 'node:readline/promises';
// Loads .env* the same way Next.js does, before any Firebase module.
import '../src/server/load-env';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email.includes('@')) {
  console.error('\n  Usage: npx tsx scripts/check-admin-password.mts <email>\n');
  process.exit(1);
}

const { findUserByEmail, getCredentials } = await import('../src/lib/firebase/repositories/users');
const { verifyPassword } = await import('../src/lib/crypto/hash');

const user = await findUserByEmail(email);
const credential = user ? await getCredentials(user.id) : null;
if (!user || !credential) {
  console.log(`\n  No account with credentials for ${email}.\n`);
  process.exit(1);
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
});
const prompt = '  Password (input hidden): ';
// Echo only the prompt itself, not the keystrokes.
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
  if (s.includes(prompt)) process.stdout.write(prompt);
};
const password = await rl.question(prompt);
rl.close();
process.stdout.write('\n');

const exact = await verifyPassword(password, credential.passwordHash);
const trimmed = password !== password.trim() && (await verifyPassword(password.trim(), credential.passwordHash));

console.log(`\n  account:  ${user.email}  role=${user.role}  status=${user.accountStatus}`);
console.log(`  created:  ${user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt}`);
console.log(`  failed logins: ${user.failedLoginCount}/8   locked until: ${user.lockedUntil ?? 'not locked'}`);
if (exact.valid) {
  console.log('\n  MATCH - this password is correct for this account.\n');
} else if (trimmed && trimmed.valid) {
  console.log('\n  MATCH ONLY WITHOUT SURROUNDING SPACES - your copy picked up whitespace.\n');
} else {
  console.log(
    '\n  NO MATCH - this is not the password this account was created with.\n' +
      '  Each `bootstrap-admin --wipe` run replaced the admin and printed a NEW password;\n' +
      '  use the one printed at the "created" time above.\n',
  );
}
process.exit(0);
