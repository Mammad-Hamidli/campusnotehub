import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';

/**
 * Reference data: universities and faculties.
 *
 * ---------------------------------------------------------------------------
 * THE ONE COLLECTION PAIR THAT IS PUBLICLY READABLE
 * ---------------------------------------------------------------------------
 * Everything else in this app is either owner-scoped or server-only, but the
 * registration form renders the university dropdown BEFORE anyone has an
 * account, so `universities` and `faculties` are `allow read: if true` in the
 * rules. That is safe precisely because these documents are a public catalogue
 * - an institution's name, city and mail domains are printed on its website.
 *
 * Nothing user-derived may ever be denormalised into them for that reason.
 */

export type UniversityRecord = {
  id: string;
  code: string;
  nameAz: string;
  nameEn: string;
  nameRu: string;
  city: string;
  emailDomains: string[];
  logoUrl: string | null;
  isActive: boolean;
  createdAt: Date;
};

export type FacultyRecord = {
  id: string;
  universityId: string;
  nameAz: string;
  nameEn: string;
  nameRu: string;
};

const universities = () => adminDb().collection(COLLECTIONS.universities);
const faculties = () => adminDb().collection(COLLECTIONS.faculties);

export async function findUniversityById(id: string): Promise<UniversityRecord | null> {
  return docToObject<UniversityRecord>(await universities().doc(id).get()) as UniversityRecord | null;
}

/**
 * Lookup by `code` - the stable short form ('ADA', 'BDU') the registration
 * form submits, as opposed to the generated document id the user document
 * actually stores in `universityId`.
 *
 * The active filter is part of the query rather than applied afterwards: a
 * deactivated institution must not be registerable, and doing that check in
 * memory is the kind of thing that survives a refactor as a bug.
 */
export async function findUniversityByCode(code: string): Promise<UniversityRecord | null> {
  const snap = await universities()
    .where('code', '==', code)
    .where('isActive', '==', true)
    .limit(1)
    .get();
  return snap.empty ? null : (docToObject<UniversityRecord>(snap.docs[0]) as UniversityRecord);
}

export async function listUniversities(includeInactive = false): Promise<UniversityRecord[]> {
  const query = includeInactive ? universities() : universities().where('isActive', '==', true);
  const rows = docsToObjects<UniversityRecord>((await query.get()).docs) as UniversityRecord[];
  // Sorted here rather than with orderBy: combining it with the isActive
  // equality would need a composite index for a list of a few dozen rows.
  return rows.sort((a, b) => a.nameEn.localeCompare(b.nameEn));
}

export async function findUniversitiesByIds(
  ids: string[],
): Promise<Map<string, UniversityRecord>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, UniversityRecord>();
  if (unique.length === 0) return out;

  // Batched by 30, Firestore's ceiling for an `in` filter. Replaces the join
  // that decorated a user list with its institutions.
  for (let i = 0; i < unique.length; i += 30) {
    const snap = await universities()
      .where('__name__', 'in', unique.slice(i, i + 30))
      .get();
    for (const row of docsToObjects<UniversityRecord>(snap.docs) as UniversityRecord[]) {
      out.set(row.id, row);
    }
  }
  return out;
}

export async function createUniversity(
  data: Partial<Omit<UniversityRecord, 'id' | 'createdAt'>> &
    Pick<UniversityRecord, 'code' | 'nameAz' | 'nameEn' | 'nameRu'>,
): Promise<UniversityRecord> {
  const ref = universities().doc();
  /**
   * `logoUrl` is defaulted to null rather than left absent.
   *
   * Firestore cannot match a document on a field it does not have, so a
   * university created without this key would be invisible to any future
   * `where('logoUrl', '==', null)` - the same trap documented on the admin
   * stats route for `deletedAt`. Optional means "null", never "missing".
   */
  const record = {
    city: null,
    logoUrl: null,
    emailDomains: [] as string[],
    isActive: true,
    ...data,
    createdAt: new Date(),
  } as Omit<UniversityRecord, 'id'>;
  await ref.set(forFirestore(record));
  return { id: ref.id, ...record };
}

export async function updateUniversity(
  id: string,
  patch: Partial<Omit<UniversityRecord, 'id'>>,
): Promise<void> {
  await universities().doc(id).update(forFirestore(patch));
}

/**
 * True when another university already claims this code.
 *
 * Firestore has no unique index, so the constraint Postgres enforced with
 * `code String @unique` has to be checked on the write path. `excludeId` lets
 * an edit keep its own code without colliding with itself.
 */
export async function universityCodeTaken(code: string, excludeId?: string): Promise<boolean> {
  const snap = await universities().where('code', '==', code).limit(2).get();
  return snap.docs.some((doc) => doc.id !== excludeId);
}

// ---------------------------------------------------------------------------

export async function listFaculties(universityId?: string): Promise<FacultyRecord[]> {
  const query = universityId
    ? faculties().where('universityId', '==', universityId)
    : faculties();
  const rows = docsToObjects<FacultyRecord>((await query.get()).docs) as FacultyRecord[];
  return rows.sort((a, b) => a.nameEn.localeCompare(b.nameEn));
}

export async function findFacultyById(id: string): Promise<FacultyRecord | null> {
  return docToObject<FacultyRecord>(await faculties().doc(id).get()) as FacultyRecord | null;
}

export async function countFaculties(universityId: string): Promise<number> {
  const snap = await faculties().where('universityId', '==', universityId).count().get();
  return snap.data().count;
}
