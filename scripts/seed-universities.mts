/**
 * Seeds the `universities` reference catalogue from src/lib/universities.ts.
 *
 *   npx tsx scripts/seed-universities.mts
 *
 * The registration form submits a university CODE from that static list and
 * POST /api/auth/register resolves it with findUniversityByCode(). prisma/seed.ts
 * used to populate the table; when it was removed in the Firestore migration
 * nothing replaced it, so on an empty project every registration was refused
 * with a 400 at the final "Send for verification" step.
 *
 * Idempotent: matches on `code`. Missing institutions are created active;
 * existing ones get their names/domains refreshed but `isActive` is left
 * alone, so a university an admin deactivated stays deactivated.
 */
import '../src/server/load-env';
import { adminDb } from '../src/lib/firebase/admin.core';
import { COLLECTIONS } from '../src/lib/firebase/collections';
import { UNIVERSITIES } from '../src/lib/universities';

const universities = adminDb().collection(COLLECTIONS.universities);
let created = 0;
let updated = 0;

for (const uni of UNIVERSITIES) {
  const fields = { code: uni.id, nameAz: uni.az, nameEn: uni.en, nameRu: uni.ru, emailDomains: uni.domains };
  const existing = await universities.where('code', '==', uni.id).limit(1).get();

  if (existing.empty) {
    await universities.doc().set({ ...fields, city: null, logoUrl: null, isActive: true, createdAt: new Date() });
    created += 1;
  } else {
    await existing.docs[0].ref.update(fields);
    updated += 1;
  }
}

console.log(`universities: ${created} created, ${updated} updated (${UNIVERSITIES.length} in catalogue)`);
process.exit(0);
