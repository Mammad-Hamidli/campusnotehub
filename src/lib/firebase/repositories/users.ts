import { FieldValue } from 'firebase-admin/firestore';
import type { AccountStatus, UserRole, VerificationStatus } from '@/lib/enums';
import type { WeeklyRule } from '@/lib/mentors/schedule';
import { adminDb } from '../admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';

/**
 * Users, and the credentials that are deliberately NOT stored with them.
 *
 * ===========================================================================
 * THE CREDENTIAL SPLIT - THE MOST IMPORTANT DECISION IN THIS FILE
 * ===========================================================================
 * `users/{id}` holds the profile. `credentials/{id}` holds the argon2id
 * password hash and the PII HMACs, in a separate collection that the security
 * rules deny to every client unconditionally.
 *
 * WHY SPLIT AT ALL: Firestore grants are per DOCUMENT, not per field. Under
 * Postgres these columns were protected by never appearing in a SELECT list -
 * a protection that does not survive the move, because "this user may read
 * their own user document" would mean "may read every field in it, including
 * passwordHash". Putting them in a different collection is the only way to
 * express the same boundary in Firestore.
 *
 * WHY THE HASH STAYS ARGON2: Firebase Authentication can import bcrypt,
 * scrypt, PBKDF and SHA-family digests. It cannot verify argon2id. Handing
 * password checking to Firebase would therefore mean re-hashing every account
 * with a weaker algorithm - a real downgrade, silently applied to people who
 * never agreed to it. So the application keeps verifying passwords itself with
 * the existing argon2id code, exactly as before, and Firebase Auth is used for
 * identity rather than for credentials.
 *
 * The net security position is unchanged from Postgres: only the server, using
 * privileged credentials, can read the hash.
 */

const CREDENTIALS = 'credentials';

/** The profile shape the application works with. Mirrors the Prisma model. */
export type UserRecord = {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  nickname: string;
  nicknameLower: string;
  avatarUrl: string | null;
  headline: string | null;
  bio: string | null;
  locale: string;
  timezone: string;
  role: UserRole;
  accountStatus: AccountStatus;
  universityId: string | null;
  facultyId: string | null;
  facultySlug: string | null;
  facultyOther: string | null;
  department: string | null;
  academicTitle: string | null;
  verificationStatus: VerificationStatus;
  isVerified: boolean;
  verifiedAt: Date | null;
  studentStatusConfirmed: boolean;
  identityConfirmed: boolean;
  graduationYear: number | null;
  graduationMonth: number | null;
  alumniTransitionedAt: Date | null;
  graduationPromptedAt: Date | null;
  /**
   * MENTOR accounts: the weekly availability stated at signup, in `timezone`.
   * A draft only - bookings read mentorProfiles/{id}/availability, which the
   * mentor application creates. This prefills that application. Absent
   * (undefined) on documents written before the field existed.
   */
  mentorAvailability?: WeeklyRule[] | null;
  frozenUntil: Date | null;
  frozenReason: string | null;
  frozenById: string | null;
  frozenAt: Date | null;
  showRealName: string;
  showEmail: string;
  showPhone: string;
  showUniversity: string;
  showFaculty: string;
  showGraduationYear: string;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/** Never returned to a client, never joined onto a user document. */
export type CredentialRecord = {
  id: string;
  passwordHash: string;
  emailHash: string;
  phoneHash: string | null;
};

const users = () => adminDb().collection(COLLECTIONS.users);
const credentials = () => adminDb().collection(CREDENTIALS);

export async function findUserById(id: string): Promise<UserRecord | null> {
  return docToObject<UserRecord>(await users().doc(id).get()) as UserRecord | null;
}

/**
 * Lookup by email.
 *
 * Email is unique in the SQL schema; Firestore has no unique constraint, so
 * uniqueness is enforced on the WRITE path (createUser below) and this reader
 * takes the first match. `limit(1)` keeps it a single-document read.
 */
export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const snap = await users().where('email', '==', email.toLowerCase()).limit(1).get();
  return snap.empty ? null : (docToObject<UserRecord>(snap.docs[0]) as UserRecord);
}

/**
 * Lookup by nickname, case-insensitively.
 *
 * Postgres enforced this with `CREATE UNIQUE INDEX ON users (lower(nickname))`
 * because impersonation via casing ("Aysel" vs "aysel") is the oldest trick on
 * any social product. Firestore cannot index an expression, so the lowercase
 * form is DENORMALISED into `nicknameLower` at write time and queried here.
 */
export async function findUserByNickname(nickname: string): Promise<UserRecord | null> {
  const snap = await users().where('nicknameLower', '==', nickname.toLowerCase()).limit(1).get();
  return snap.empty ? null : (docToObject<UserRecord>(snap.docs[0]) as UserRecord);
}

export async function findUsersByIds(ids: string[]): Promise<Map<string, UserRecord>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();

  /**
   * Batched by 30 because that is Firestore's ceiling for an `in` filter.
   * This is the pattern that replaces a SQL join: instead of N+1 reads to
   * decorate a feed page with its authors, the ids are collected and fetched
   * in one round trip per 30.
   */
  const out = new Map<string, UserRecord>();
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    const snap = await adminDb().getAll(...chunk.map((id) => users().doc(id)));
    for (const doc of snap) {
      const row = docToObject<UserRecord>(doc);
      if (row) out.set(row.id, row as UserRecord);
    }
  }
  return out;
}

export async function getCredentials(userId: string): Promise<CredentialRecord | null> {
  return docToObject<CredentialRecord>(await credentials().doc(userId).get()) as CredentialRecord | null;
}

/** Finds the account owning an email HMAC, without ever reading a hash out. */
export async function findUserIdByEmailHash(emailHash: string): Promise<string | null> {
  const snap = await credentials().where('emailHash', '==', emailHash).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

export async function findUserIdByPhoneHash(phoneHash: string): Promise<string | null> {
  const snap = await credentials().where('phoneHash', '==', phoneHash).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

export class DuplicateUserError extends Error {
  constructor(readonly field: 'email' | 'phone' | 'nickname') {
    super(`duplicate ${field}`);
  }
}

/**
 * Creates a user and its credentials atomically.
 *
 * ---------------------------------------------------------------------------
 * UNIQUENESS WITHOUT UNIQUE CONSTRAINTS
 * ---------------------------------------------------------------------------
 * Postgres enforced unique email, phone, nickname and their HMACs with
 * indexes. Firestore has none, so uniqueness is asserted inside a
 * TRANSACTION: the reads happen first, and Firestore aborts and retries the
 * whole transaction if any document read during it changed before commit.
 * That is what closes the read-then-write race two simultaneous signups would
 * otherwise win together.
 *
 * It is weaker than a database constraint and it is worth being honest about
 * that: a unique index cannot be bypassed, whereas this can be if some future
 * code path writes a user outside this function. That is why creation is
 * funnelled through here.
 */
/**
 * Every column Postgres filled in by itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `@default(...)` in the Prisma schema was enforced by the DATABASE: an INSERT
 * that omitted `showEmail` still ended up with PRIVATE, because Postgres wrote
 * it. Firestore has no defaults - an omitted field is simply absent, and an
 * absent field reads back as `undefined`.
 *
 * That difference is dangerous in exactly one direction. `showEmail` missing
 * instead of 'PRIVATE' does not fail loudly; it makes a visibility check
 * comparing against 'PUBLIC' fall through to whatever the caller treats as a
 * default, and a privacy field that quietly stops meaning "private" is the
 * worst kind of regression. The same applies to `isVerified` (absent is not
 * false to a `=== true` check written defensively elsewhere) and to
 * `accountStatus`.
 *
 * So the defaults are stated once, here, next to the only function that
 * creates users - rather than being re-typed at each call site, where one
 * omission would be invisible until it mattered. The values are copied from
 * the `@default` annotations in prisma/schema.prisma and must stay in step
 * with them while Postgres remains the fallback.
 */
export function newUserDefaults(): Omit<
  UserRecord,
  | 'id'
  | 'nicknameLower'
  | 'email'
  | 'fullName'
  | 'nickname'
  | 'createdAt'
  | 'updatedAt'
> {
  return {
    phone: null,
    firstName: null,
    lastName: null,
    dateOfBirth: null,
    avatarUrl: null,
    headline: null,
    bio: null,
    locale: 'az',
    timezone: 'Asia/Baku',
    role: 'STUDENT' as UserRole,
    accountStatus: 'ACTIVE' as AccountStatus,
    universityId: null,
    facultyId: null,
    facultySlug: null,
    facultyOther: null,
    department: null,
    academicTitle: null,
    verificationStatus: 'UNVERIFIED' as VerificationStatus,
    isVerified: false,
    verifiedAt: null,
    studentStatusConfirmed: false,
    identityConfirmed: false,
    graduationYear: null,
    graduationMonth: null,
    alumniTransitionedAt: null,
    graduationPromptedAt: null,
    mentorAvailability: null,
    frozenUntil: null,
    frozenReason: null,
    frozenById: null,
    frozenAt: null,
    // Privacy defaults: the conservative reading. Anything identifying starts
    // closed; only the institution is public, matching the SQL schema.
    showRealName: 'VERIFIED_ONLY',
    showEmail: 'PRIVATE',
    showPhone: 'PRIVATE',
    showUniversity: 'PUBLIC',
    showFaculty: 'VERIFIED_ONLY',
    showGraduationYear: 'VERIFIED_ONLY',
    emailVerifiedAt: null,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    deletedAt: null,
  };
}

/** Reserves the id before the write, so a caller can reference it first. */
export function newUserId(): string {
  return adminDb().collection(COLLECTIONS.users).doc().id;
}

export async function createUser(params: {
  profile: Omit<UserRecord, 'id' | 'nicknameLower'> & { id: string };
  credentials: Omit<CredentialRecord, 'id'>;
}): Promise<UserRecord> {
  const db = adminDb();
  const { profile, credentials: creds } = params;

  await db.runTransaction(async (tx) => {
    const [byEmail, byNickname, byEmailHash] = await Promise.all([
      tx.get(users().where('email', '==', profile.email).limit(1)),
      tx.get(users().where('nicknameLower', '==', profile.nickname.toLowerCase()).limit(1)),
      tx.get(credentials().where('emailHash', '==', creds.emailHash).limit(1)),
    ]);

    if (!byEmail.empty || !byEmailHash.empty) throw new DuplicateUserError('email');
    if (!byNickname.empty) throw new DuplicateUserError('nickname');

    if (creds.phoneHash) {
      const byPhoneHash = await tx.get(credentials().where('phoneHash', '==', creds.phoneHash).limit(1));
      if (!byPhoneHash.empty) throw new DuplicateUserError('phone');
    }

    tx.set(
      users().doc(profile.id),
      forFirestore({ ...profile, nicknameLower: profile.nickname.toLowerCase() }),
    );
    // Separate collection, denied to clients by rule. See the header.
    tx.set(credentials().doc(profile.id), forFirestore({ ...creds }));
  });

  const created = await findUserById(profile.id);
  if (!created) throw new Error('user vanished immediately after creation');
  return created;
}

export async function updateUser(id: string, patch: Record<string, unknown>): Promise<void> {
  const data = forFirestore({ ...patch, updatedAt: new Date() });
  // Keep the denormalised lowercase handle in step with the handle itself.
  if (typeof patch.nickname === 'string') {
    data.nicknameLower = patch.nickname.toLowerCase();
  }
  await users().doc(id).update(data);
}

export async function updateCredentials(id: string, patch: Record<string, unknown>): Promise<void> {
  await credentials().doc(id).set(forFirestore(patch), { merge: true });
}

/** Atomic counter, for the failed-login tally. */
export async function incrementFailedLogins(id: string, lockedUntil: Date | null): Promise<void> {
  await users().doc(id).update(
    forFirestore({
      failedLoginCount: FieldValue.increment(1),
      lockedUntil,
      updatedAt: new Date(),
    }),
  );
}

export type UserListFilter = {
  q?: string;
  role?: string;
  accountStatus?: string;
  verificationStatus?: string;
  universityId?: string;
  includeDeleted?: boolean;
  createdFrom?: Date;
  createdTo?: Date;
};

/**
 * The admin user list.
 *
 * ---------------------------------------------------------------------------
 * WHY FILTERING AND PAGING HAPPEN PARTLY IN MEMORY
 * ---------------------------------------------------------------------------
 * Firestore has no `OR` across different fields and no substring search, and
 * the admin table offers a free-text box that matches name, nickname OR email
 * simultaneously. There is no query that expresses that.
 *
 * The equality filters that Firestore CAN index are pushed into the query, so
 * the server only ever materialises rows already narrowed by role, status and
 * university. The text match and the final sort then run over that reduced
 * set. On an administrative table - bounded by the operator's own filters and
 * capped below - this is the right trade; it is explicitly not the pattern for
 * a user-facing feed.
 *
 * If the user table ever outgrows this, the answer is a search index
 * (Algolia/Typesense), not a bigger in-memory scan.
 */
const ADMIN_SCAN_CEILING = 3000;

export async function listUsers(
  filter: UserListFilter,
  page: number,
  pageSize: number,
  sort: string,
  order: 'asc' | 'desc',
): Promise<{ users: UserRecord[]; total: number }> {
  let query: FirebaseFirestore.Query = users();

  if (filter.role) query = query.where('role', '==', filter.role);
  if (filter.accountStatus) query = query.where('accountStatus', '==', filter.accountStatus);
  if (filter.verificationStatus) query = query.where('verificationStatus', '==', filter.verificationStatus);
  if (filter.universityId) query = query.where('universityId', '==', filter.universityId);

  const snap = await query.limit(ADMIN_SCAN_CEILING).get();
  let rows = docsToObjects<UserRecord>(snap.docs) as UserRecord[];

  if (!filter.includeDeleted) rows = rows.filter((u) => !u.deletedAt);
  if (filter.createdFrom) rows = rows.filter((u) => u.createdAt >= filter.createdFrom!);
  if (filter.createdTo) rows = rows.filter((u) => u.createdAt <= filter.createdTo!);

  if (filter.q) {
    const needle = filter.q.toLowerCase();
    rows = rows.filter(
      (u) =>
        u.fullName?.toLowerCase().includes(needle) ||
        u.nickname?.toLowerCase().includes(needle) ||
        u.email?.toLowerCase().includes(needle),
    );
  }

  const total = rows.length;

  rows.sort((a, b) => {
    const left = a[sort as keyof UserRecord];
    const right = b[sort as keyof UserRecord];
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    const cmp =
      left instanceof Date && right instanceof Date
        ? left.getTime() - right.getTime()
        : String(left).localeCompare(String(right));
    return order === 'asc' ? cmp : -cmp;
  });

  return { users: rows.slice((page - 1) * pageSize, page * pageSize), total };
}

/** Counts for the admin dashboard, using aggregation rather than fetching rows. */
export async function countUsers(where: Record<string, unknown> = {}): Promise<number> {
  let query: FirebaseFirestore.Query = users();
  for (const [field, value] of Object.entries(where)) {
    query = query.where(field, '==', value);
  }
  const snap = await query.count().get();
  return snap.data().count;
}

/**
 * The four numbers a profile header shows.
 *
 * ---------------------------------------------------------------------------
 * WHY count() AND NOT A DENORMALISED COUNTER
 * ---------------------------------------------------------------------------
 * Prisma's `_count` compiled to correlated subqueries in one round trip. The
 * closest Firestore equivalent is the count() aggregation, which is billed per
 * index entry read rather than per document returned - so it does NOT stream
 * the collection to the server, and the cost is bounded even for a prolific
 * author.
 *
 * The alternative - counters incremented on every post and follow - is faster
 * to read but introduces a value that can silently disagree with reality, and
 * a follower count that drifts is the kind of bug nobody notices until a user
 * reports it. These counts are exact by construction, which is worth a
 * round trip on a page that already makes several.
 *
 * The four run concurrently because none depends on another.
 */
export async function profileCounts(userId: string): Promise<{
  posts: number;
  notes: number;
  followers: number;
  following: number;
}> {
  const db = adminDb();
  const [posts, notes, followers, following] = await Promise.all([
    // Deleted posts are excluded, matching what the feed will actually show.
    db
      .collection(COLLECTIONS.posts)
      .where('authorId', '==', userId)
      .where('isDeleted', '==', false)
      .count()
      .get(),
    db.collection(COLLECTIONS.notes).where('sellerId', '==', userId).count().get(),
    db.collection(SUBCOLLECTIONS.userFollowers(userId)).count().get(),
    db.collection(SUBCOLLECTIONS.userFollowing(userId)).count().get(),
  ]);

  return {
    posts: posts.data().count,
    notes: notes.data().count,
    followers: followers.data().count,
    following: following.data().count,
  };
}
