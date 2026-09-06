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
 * Operator-only, run against a database the operator already has credentials
 * for. It writes an audit row so a password change made out of band is still
 * visible in the log, exactly like one made through the app.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/crypto/hash';

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

const db = new PrismaClient();

try {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, nickname: true, role: true, accountStatus: true, deletedAt: true },
  });

  if (!user) {
    console.error(`\n  No account with that email.\n`);
    process.exit(1);
  }
  if (user.deletedAt) {
    console.error(`\n  That account is deleted. Restore it before setting a password.\n`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // A forgotten password often means a lockout is already in force from
        // failed attempts. Clearing both is the point of the reset.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    /**
     * Every existing session is revoked.
     *
     * A password reset that leaves old sessions alive does not actually take
     * anything back - whoever held the account before still holds it. This is
     * also why requireSession() checks the session row on every request: the
     * revocation below is effective immediately, not when a token expires.
     */
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'USER_PASSWORD_RESET_CLI',
        entityType: 'user',
        entityId: user.id,
        result: 'SUCCESS',
        // The password itself is never written anywhere but the hash column.
        after: { method: 'operator cli', sessionsRevoked: true },
      },
    });
  });

  console.log(`\n  Password updated for @${user.nickname} (${user.role})`);
  console.log(`  All existing sessions were revoked - sign in again.\n`);
} finally {
  await db.$disconnect();
}
