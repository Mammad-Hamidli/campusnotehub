import { FieldValue } from 'firebase-admin/firestore';
import type { AccountStatus, UserRole, VerificationStatus } from '@/lib/enums';
import type { WeeklyRule } from '@/lib/mentors/schedule';
import { usernameKey } from '@/lib/auth/username';
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
  /**
   * Historical. It was set when the owner proved the number by SMS code; SMS
   * was removed on 2026-09-22, so nothing writes it any more and no code path
   * reads it as a permission. Kept on the type because existing documents
   * still carry it, and absent reads as "not verified" - the safe default.
   */
  phoneVerifiedAt?: Date | null;
  /**
   * True for an account created by a quick login (Google)
   * that still carries its temporary "user12345" handle. The account is
   * view-only until completeProfile() clears it - see permissions.can().
   * Absent on every other document, which reads as "complete".
   */
  profileIncomplete?: boolean;
  /**
   * True for a Google-created account that finished its profile before a
   * local password was required, found on its next Google sign-in. The
   * account is view-only and every page sends it to /set-password until
   * setInitialPassword() clears it. Absent reads as "nothing owed".
   */
  passwordSetupRequired?: boolean;
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
  /**
   * Null for an account created through Google, which has
   * never had a password. Every password check must treat null as "cannot
   * sign in with a password" - see the login route and lib/auth/reauth.ts.
   */
  passwordHash: string | null;
  emailHash: string;
  phoneHash: string | null;
};

const users = () => adminDb().collection(COLLECTIONS.users);
const credentials = () => adminDb().collection(CREDENTIALS);
const usernames = () => adminDb().collection(COLLECTIONS.usernames);

/** `usernames/{key}`. The document id IS the normalised handle. */
export type UsernameClaim = { userId: string; createdAt: Date };

/**
 * The claim key for a stored nickname. Every stored nickname already passed
 * USERNAME_PATTERN at registration, so a null here means corrupted data - and
 * that must fail loudly rather than write a claim under some other key.
 */
function claimKeyFor(nickname: string): string {
  const key = usernameKey(nickname);
  if (!key) throw new Error(`nickname does not satisfy USERNAME_PATTERN: ${JSON.stringify(nickname)}`);
  return key;
}

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

/**
 * Login lookup by username. `key` must already be normalised by usernameKey().
 *
 * The claim document is the source of truth: a point read, and the same
 * record createUser() makes unique. Two cross-checks keep it honest:
 *
 *  - A claim whose user no longer carries that handle is STALE and resolves to
 *    nobody. It is never followed to "whoever the claim points at", because a
 *    claim that outlived a rename would otherwise log someone into an account
 *    by its OLD public name.
 *  - With no claim at all, fall back to the denormalised `nicknameLower`
 *    query. That covers accounts created before claims existed, until
 *    scripts/backfill-usernames.mts has run. It stays afterwards on purpose: it
 *    costs one read, only on a miss, and it gives a miss the same number of
 *    round trips as a hit, so response time does not reveal which handles
 *    exist.
 *
 * Handles of deleted accounts keep their claim and are still found here; the
 * login route refuses a deleted account with its generic failure. They are
 * never recycled either - a freed handle is the easiest impersonation there is.
 */
export async function findUserByUsername(key: string): Promise<UserRecord | null> {
  const claim = await usernames().doc(key).get();
  if (claim.exists) {
    const { userId } = claim.data() as UsernameClaim;
    const user = await findUserById(userId);
    return user && user.nicknameLower === key ? user : null;
  }
  // limit(2), not 1: two legacy accounts sharing a handle (possible before the
  // claim existed) must resolve to NOBODY rather than to whichever Firestore
  // returned first. The backfill reports such pairs for an operator to settle.
  const snap = await users().where('nicknameLower', '==', key).limit(2).get();
  return snap.size === 1 ? (docToObject<UserRecord>(snap.docs[0]) as UserRecord) : null;
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

/** The identifiers signup can collide on, in the order the form shows them. */
export type ConflictField = 'email' | 'phone' | 'nickname' | 'identity';

const CONFLICT_ORDER: ConflictField[] = ['email', 'phone', 'nickname', 'identity'];

/**
 * A uniqueness clash, carrying EVERY field that clashed.
 *
 * It used to carry exactly one, because createUser() threw on the first check
 * that failed. That made "your email and your phone are both in use" arrive as
 * "your email is in use", the caller fixed the email, and the same request
 * came back a second time blaming the phone. The checks now all run before
 * anything is thrown, so one submit produces one complete answer.
 *
 * `field` is kept as the FIRST clash so callers that only ever handled one
 * (quick-signup, completeProfile) are unaffected.
 */
export class DuplicateUserError extends Error {
  readonly fields: ConflictField[];

  constructor(fields: ConflictField | ConflictField[]) {
    const list = (Array.isArray(fields) ? fields : [fields]).slice();
    list.sort((a, b) => CONFLICT_ORDER.indexOf(a) - CONFLICT_ORDER.indexOf(b));
    super(`duplicate ${list.join(', ')}`);
    this.fields = list;
  }

  get field(): ConflictField {
    return this.fields[0];
  }
}

/**
 * How many matches an identifier lookup reads before deciding.
 *
 * One was enough while every match was assumed to be real. It is not enough
 * now that a match may be STALE (see liveOwners below): with limit(1) a single
 * orphaned document would be purged and a second, live one behind it would go
 * unseen. A healthy database has at most one match for any of these
 * identifiers, so five is already far past what can legitimately exist - it is
 * headroom for a database that has been cleared by hand, which is exactly the
 * situation this guards.
 */
const IDENTIFIER_SCAN = 5;

/**
 * Splits identifier documents into the ones a LIVE account still owns and the
 * ones that outlived their account.
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO FIX
 * ===========================================================================
 * `credentials/{userId}` and `usernames/{handle}` are separate top-level
 * collections from `users/{userId}`. Nothing in Firestore ties their lifetimes
 * together - there is no ON DELETE CASCADE - so deleting user documents (from
 * the console, from a reset script, from anything that is not a full purge)
 * leaves their credential and claim documents behind.
 *
 * Those leftovers carry `emailHash` and `phoneHash`. The uniqueness check read
 * them and refused every signup that reused the address or number, with an
 * error the operator could not clear by emptying `users` - because `users` was
 * never where the blocking document lived. That is the false positive.
 *
 * A document whose owner is gone therefore proves nothing and must not block.
 * It is also garbage, so the caller deletes it in the same transaction rather
 * than leaving it to fail the next signup too.
 *
 * WHY THIS IS NOT A SECURITY REGRESSION: identifiers that must never be reused
 * are the BANNED ones, and those live in `blocklist/{type__hash}`, which is
 * checked separately before this function is ever reached and is not touched
 * here. Soft-deleted accounts keep their `users` document, so they are "live"
 * by this test and still block - recycling the address of a deleted account
 * remains impossible.
 */
type OwnerSplit = {
  /** Ids of accounts that really hold the identifier. */
  live: string[];
  /** Documents whose owning account no longer exists. Safe to remove. */
  stale: FirebaseFirestore.DocumentReference[];
};

async function liveOwners(
  tx: FirebaseFirestore.Transaction,
  candidates: { ref: FirebaseFirestore.DocumentReference; ownerId: string }[],
): Promise<OwnerSplit> {
  const split: OwnerSplit = { live: [], stale: [] };
  if (candidates.length === 0) return split;

  // Still a READ, so it stays legal before the transaction's writes.
  const owners = await Promise.all(candidates.map((c) => tx.get(users().doc(c.ownerId))));
  candidates.forEach((candidate, index) => {
    if (owners[index].exists) split.live.push(candidate.ownerId);
    else split.stale.push(candidate.ref);
  });
  return split;
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
    phoneVerifiedAt: null,
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
  /**
   * A provider identity to link in the SAME transaction - a social sign-up.
   * Atomic on purpose: an account created without its identity would be an
   * account nobody can sign in to (it has no password), and an identity
   * written without its account would point at nothing.
   */
  identity?: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> };
}): Promise<UserRecord> {
  const db = adminDb();
  const { profile, credentials: creds, identity } = params;
  const nicknameKey = claimKeyFor(profile.nickname);

  await db.runTransaction(async (tx) => {
    // ---------------------------------------------------------------------
    // READS. Firestore requires all of them before any write in the same
    // transaction, and every check below is a read, so nothing is written
    // until the last one has been decided.
    // ---------------------------------------------------------------------
    if (identity && (await tx.get(identity.ref)).exists) throw new DuplicateUserError('identity');

    /**
     * The username is checked TWICE, deliberately. The claim document is the
     * real constraint: its id is the key, so two signups racing for "aysel"
     * contend on one document and Firestore lets exactly one commit. The
     * `nicknameLower` query still catches accounts written before claims
     * existed that the backfill has not reached - without it, a new signup
     * could claim a handle an older account is already displaying.
     */
    const [byEmail, byNickname, byEmailHash, byPhoneHash, claim] = await Promise.all([
      tx.get(users().where('email', '==', profile.email).limit(IDENTIFIER_SCAN)),
      tx.get(users().where('nicknameLower', '==', nicknameKey).limit(IDENTIFIER_SCAN)),
      tx.get(credentials().where('emailHash', '==', creds.emailHash).limit(IDENTIFIER_SCAN)),
      creds.phoneHash
        ? tx.get(credentials().where('phoneHash', '==', creds.phoneHash).limit(IDENTIFIER_SCAN))
        : null,
      tx.get(usernames().doc(nicknameKey)),
    ]);

    /**
     * Resolved against their owners, because a credential or claim document
     * whose account is gone is leftover state, not a duplicate. See
     * liveOwners() for the whole reasoning - it is the fix for signups that
     * kept failing after the `users` collection had been emptied.
     *
     * The `users` queries need no such resolution: there the matched document
     * IS the account.
     */
    const [emailCreds, phoneCreds, staleClaimOwner] = await Promise.all([
      liveOwners(tx, byEmailHash.docs.map((doc) => ({ ref: doc.ref, ownerId: doc.id }))),
      byPhoneHash
        ? liveOwners(tx, byPhoneHash.docs.map((doc) => ({ ref: doc.ref, ownerId: doc.id })))
        : Promise.resolve({ live: [], stale: [] } as OwnerSplit),
      claim.exists
        ? liveOwners(tx, [{ ref: claim.ref, ownerId: (claim.data() as UsernameClaim).userId }])
        : Promise.resolve({ live: [], stale: [] } as OwnerSplit),
    ]);

    /**
     * EVERY clash, not the first one.
     *
     * Throwing at the first failed check meant an account whose email AND
     * phone were both taken had to submit twice to learn both. The route
     * turns this set into one error per field.
     */
    const conflicts: ConflictField[] = [];
    if (!byEmail.empty || emailCreds.live.length > 0) conflicts.push('email');
    if (phoneCreds.live.length > 0) conflicts.push('phone');
    if (!byNickname.empty || staleClaimOwner.live.length > 0) conflicts.push('nickname');
    if (conflicts.length > 0) throw new DuplicateUserError(conflicts);

    // ---------------------------------------------------------------------
    // WRITES.
    // ---------------------------------------------------------------------

    /**
     * The leftovers are removed on the way past. Leaving them would mean the
     * next signup for a different address pays the same extra reads, and an
     * operator reading the database would still see documents that look like
     * live accounts.
     *
     * The stale CLAIM is excluded here on purpose - see the set/create below.
     */
    for (const ref of [...emailCreds.stale, ...phoneCreds.stale]) tx.delete(ref);

    tx.set(
      users().doc(profile.id),
      forFirestore({ ...profile, nicknameLower: nicknameKey }),
    );
    // Separate collection, denied to clients by rule. See the header.
    tx.set(credentials().doc(profile.id), forFirestore({ ...creds }));

    const claimData = forFirestore({
      userId: profile.id,
      createdAt: new Date(),
    } satisfies UsernameClaim);
    if (staleClaimOwner.stale.length > 0) {
      /**
       * set(), because this claim is a leftover whose account is gone and we
       * are replacing it. It is NOT delete()-then-create(): both would land in
       * one commit, and create()'s "must not exist" precondition is evaluated
       * against the document as it stood before the commit - which is to say
       * it would fail on the document we are deleting in the same breath.
       */
      tx.set(usernames().doc(nicknameKey), claimData);
    } else {
      // create(), not set(): if the claim appeared after the read above, the
      // commit fails instead of overwriting another account's handle.
      tx.create(usernames().doc(nicknameKey), claimData);
    }
    if (identity) tx.create(identity.ref, forFirestore({ ...identity.data, userId: profile.id }));
  });

  const created = await findUserById(profile.id);
  if (!created) throw new Error('user vanished immediately after creation');
  return created;
}

export async function updateUser(id: string, patch: Record<string, unknown>): Promise<void> {
  /**
   * The handle is a login identifier backed by a `usernames` claim. A plain
   * field update would move the profile to a new name while the claim stayed
   * on the old one - the new name unprotected, the old one unusable. Nothing
   * renames users today; a future rename must be one transaction that releases
   * the old claim and create()s the new one, not a patch through here.
   */
  if ('nickname' in patch || 'nicknameLower' in patch) {
    throw new Error('updateUser cannot change a nickname: it is a claimed login identifier');
  }
  await users().doc(id).update(forFirestore({ ...patch, updatedAt: new Date() }));
}

/**
 * Finishes a quick-login account: real name, chosen handle, university and -
 * when the provider supplied none - an email address. Clears
 * `profileIncomplete`, which is what lifts the view-only gate.
 *
 * ONE transaction, because the handle is a claimed login identifier (see
 * updateUser): the temporary claim is released and the new one create()d in
 * the same commit, so there is never a moment where the account answers to
 * neither name, or where two racing sign-ups both get the new one.
 */
export async function completeProfile(
  userId: string,
  patch: {
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    nickname: string;
    universityId: string;
    /** The argon2id hash of the local password chosen at /onboarding. */
    passwordHash: string;
    /** Only when the account has no usable address yet. */
    email?: { value: string; hash: string };
  },
): Promise<'ok' | 'already_complete' | DuplicateUserError['field']> {
  const db = adminDb();
  const nextKey = claimKeyFor(patch.nickname);

  try {
    return await db.runTransaction(async (tx) => {
      const ref = users().doc(userId);
      const snap = await tx.get(ref);
      const current = docToObject<UserRecord>(snap) as UserRecord | null;
      if (!current) throw new Error('completeProfile: user not found');
      if (current.profileIncomplete !== true) return 'already_complete' as const;

      const prevKey = current.nicknameLower;
      const renaming = prevKey !== nextKey;

      const [byNickname, claim, byEmail, byEmailHash] = await Promise.all([
        renaming ? tx.get(users().where('nicknameLower', '==', nextKey).limit(IDENTIFIER_SCAN)) : null,
        renaming ? tx.get(usernames().doc(nextKey)) : null,
        patch.email ? tx.get(users().where('email', '==', patch.email.value).limit(IDENTIFIER_SCAN)) : null,
        patch.email
          ? tx.get(credentials().where('emailHash', '==', patch.email.hash).limit(IDENTIFIER_SCAN))
          : null,
      ]);

      /**
       * Same orphan resolution as createUser: a credential or claim document
       * left behind by a deleted account is not evidence that anyone holds
       * the identifier. Without this, finishing a quick-login profile hit the
       * identical false positive - see liveOwners().
       */
      const [emailCreds, claimOwner] = await Promise.all([
        liveOwners(
          tx,
          (byEmailHash?.docs ?? [])
            .filter((doc) => doc.id !== userId)
            .map((doc) => ({ ref: doc.ref, ownerId: doc.id })),
        ),
        claim?.exists
          ? liveOwners(tx, [{ ref: claim.ref, ownerId: (claim.data() as UsernameClaim).userId }])
          : Promise.resolve({ live: [], stale: [] } as OwnerSplit),
      ]);

      if (byNickname && !byNickname.empty) throw new DuplicateUserError('nickname');
      if (claimOwner.live.some((owner) => owner !== userId)) throw new DuplicateUserError('nickname');
      if (byEmail && byEmail.docs.some((d) => d.id !== userId)) throw new DuplicateUserError('email');
      if (emailCreds.live.length > 0) throw new DuplicateUserError('email');

      // The stale CLAIM is not deleted here: the rename below overwrites it
      // with set(), and deleting it first would be a second write to the same
      // document in one commit for no gain.
      for (const ref of emailCreds.stale) tx.delete(ref);

      tx.update(
        ref,
        forFirestore({
          fullName: patch.fullName,
          firstName: patch.firstName,
          lastName: patch.lastName,
          nickname: patch.nickname,
          nicknameLower: nextKey,
          universityId: patch.universityId,
          ...(patch.email ? { email: patch.email.value, emailVerifiedAt: null } : {}),
          profileIncomplete: false,
          passwordSetupRequired: false,
          updatedAt: new Date(),
        }),
      );
      if (renaming) {
        tx.delete(usernames().doc(prevKey));
        const claimData = forFirestore({ userId, createdAt: new Date() } satisfies UsernameClaim);
        // set() when we are replacing a leftover claim, create() otherwise -
        // the same precondition reason as in createUser().
        if (claimOwner.stale.length > 0) tx.set(usernames().doc(nextKey), claimData);
        else tx.create(usernames().doc(nextKey), claimData);
      }
      // The credentials document is created with the account, so it exists.
      tx.update(
        credentials().doc(userId),
        forFirestore({
          passwordHash: patch.passwordHash,
          passwordChangedAt: new Date(),
          ...(patch.email ? { emailHash: patch.email.hash } : {}),
        }),
      );
      return 'ok' as const;
    });
  } catch (error) {
    if (error instanceof DuplicateUserError) return error.field;
    throw error;
  }
}

/**
 * Gives a Google-created account its FIRST local password. Refuses to
 * overwrite an existing one ('already_set'): changing a password needs the
 * current one, which is /api/me/password's job, not this function's.
 */
export async function setInitialPassword(userId: string, passwordHash: string): Promise<'ok' | 'already_set'> {
  return adminDb().runTransaction(async (tx) => {
    const cred = await tx.get(credentials().doc(userId));
    if (typeof cred.data()?.passwordHash === 'string') return 'already_set' as const;
    tx.set(credentials().doc(userId), forFirestore({ passwordHash, passwordChangedAt: new Date() }), { merge: true });
    tx.update(users().doc(userId), forFirestore({ passwordSetupRequired: false, updatedAt: new Date() }));
    return 'ok' as const;
  });
}

/**
 * Renames an established account: the `usernames` claim moves in the SAME
 * transaction as the profile field - the old claim released, the new one
 * create()d - for the reason given on updateUser(). Refused for an incomplete
 * profile, which renames through completeProfile() instead.
 */
export async function renameUser(
  userId: string,
  nickname: string,
): Promise<'ok' | 'unchanged' | 'incomplete' | 'nickname'> {
  const nextKey = claimKeyFor(nickname);
  return adminDb().runTransaction(async (tx) => {
    const ref = users().doc(userId);
    const current = docToObject<UserRecord>(await tx.get(ref)) as UserRecord | null;
    if (!current) throw new Error('renameUser: user not found');
    if (current.profileIncomplete === true) return 'incomplete' as const;
    if (current.nickname === nickname) return 'unchanged' as const;

    const prevKey = current.nicknameLower;
    // Case-only change ("aysel" -> "Aysel"): same claim, just the display form.
    if (prevKey === nextKey) {
      tx.update(ref, forFirestore({ nickname, updatedAt: new Date() }));
      return 'ok' as const;
    }

    const [byNickname, claim] = await Promise.all([
      tx.get(users().where('nicknameLower', '==', nextKey).limit(IDENTIFIER_SCAN)),
      tx.get(usernames().doc(nextKey)),
    ]);
    const claimOwner = claim.exists
      ? await liveOwners(tx, [{ ref: claim.ref, ownerId: (claim.data() as UsernameClaim).userId }])
      : ({ live: [], stale: [] } as OwnerSplit);

    if (byNickname.docs.some((d) => d.id !== userId)) return 'nickname' as const;
    if (claimOwner.live.some((owner) => owner !== userId)) return 'nickname' as const;

    tx.update(ref, forFirestore({ nickname, nicknameLower: nextKey, updatedAt: new Date() }));
    tx.delete(usernames().doc(prevKey));
    const claimData = forFirestore({ userId, createdAt: new Date() } satisfies UsernameClaim);
    if (claimOwner.stale.length > 0) tx.set(usernames().doc(nextKey), claimData);
    else tx.create(usernames().doc(nextKey), claimData);
    return 'ok' as const;
  });
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
