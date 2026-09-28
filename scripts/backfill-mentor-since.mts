/**
 * Brings existing mentors in line with the mentor panel.
 *
 *   npx tsx scripts/backfill-mentor-since.mts            # dry run: report only
 *   npx tsx scripts/backfill-mentor-since.mts --apply    # write
 *
 * Two changes, the same ones an approval now makes (approveMentorApplication):
 *
 *   mentorSince   stamped where missing, on every role-MENTOR account and every
 *                 account with an approved mentor profile. The value is the
 *                 profile's approvedAt, else the account's createdAt - the
 *                 date the fee reminder counts months from.
 *   role          STUDENT -> MENTOR for an account whose profile is approved
 *                 (roleAfterMentorApproval; ALUMNI and TEACHER keep theirs).
 *
 * Safe to re-run: an existing mentorSince is never overwritten, and each write
 * is a transaction that re-reads the account first.
 */
// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';

const apply = process.argv.includes('--apply');

const { adminDb } = await import('../src/lib/firebase/admin.core');
const { COLLECTIONS } = await import('../src/lib/firebase/collections');
const { forFirestore } = await import('../src/lib/firebase/convert');
const { roleAfterMentorApproval } = await import('../src/lib/mentors/membership');

type Role = Parameters<typeof roleAfterMentorApproval>[0];

const db = adminDb();

// Equality-only queries: no composite index needed.
const [profiles, mentorAccounts] = await Promise.all([
  db.collection(COLLECTIONS.mentorProfiles).where('isApproved', '==', true).select('userId', 'approvedAt').get(),
  db.collection(COLLECTIONS.users).where('role', '==', 'MENTOR').select().get(),
]);

/** userId -> approval date (null for a MENTOR account with no approved profile yet). */
const candidates = new Map<string, Date | null>();
for (const doc of mentorAccounts.docs) candidates.set(doc.id, null);
for (const doc of profiles.docs) {
  const userId = doc.get('userId');
  if (typeof userId === 'string') candidates.set(userId, doc.get('approvedAt')?.toDate?.() ?? null);
}
const approved = new Set(profiles.docs.map((d) => d.get('userId')));

let stamped = 0;
let promoted = 0;
let untouched = 0;
const skipped: { id: string; why: string }[] = [];

for (const [userId, approvedAt] of candidates) {
  const ref = db.collection(COLLECTIONS.users).doc(userId);
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { skip: 'no user document' };
    if (snap.get('deletedAt') || snap.get('accountStatus') === 'DELETED') return { skip: 'deleted' };

    const role = snap.get('role') as Role;
    const nextRole = approved.has(userId) ? roleAfterMentorApproval(role) : role;
    const since: Date | null = snap.get('mentorSince') ? null : (approvedAt ?? snap.get('createdAt')?.toDate?.() ?? null);

    const patch = {
      ...(nextRole !== role ? { role: nextRole } : {}),
      ...(since ? { mentorSince: since } : {}),
    };
    if (Object.keys(patch).length === 0) return { patch: null };
    if (apply) tx.update(ref, forFirestore({ ...patch, updatedAt: new Date() }));
    return { patch };
  });

  if ('skip' in outcome) skipped.push({ id: userId, why: outcome.skip as string });
  else if (!outcome.patch) untouched++;
  else {
    if ('mentorSince' in outcome.patch) stamped++;
    if ('role' in outcome.patch) promoted++;
  }
}

console.log(`\n  ${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'}`);
console.log(`    mentor accounts / approved profiles   ${mentorAccounts.size} / ${profiles.size}`);
console.log(`    mentorSince ${apply ? 'stamped' : 'to stamp'}                 ${stamped}`);
console.log(`    STUDENT -> MENTOR ${apply ? 'promoted' : 'to promote'}         ${promoted}`);
console.log(`    already up to date                    ${untouched}`);
for (const { id, why } of skipped) console.log(`    skipped ${id}: ${why}`);
console.log('');
