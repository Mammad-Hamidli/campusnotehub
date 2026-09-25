import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';

/**
 * Sessions and devices.
 *
 * ---------------------------------------------------------------------------
 * THE REFRESH TOKEN HASH LIVES HERE, NOT IN THE SESSION DOCUMENT
 * ---------------------------------------------------------------------------
 * Same reasoning as the credential split for passwords: `sessions/{id}` is the
 * record an operator inspects and revokes, and a rule that let anyone read it
 * would hand out the credential alongside the metadata. The hash therefore
 * lives in `sessionSecrets/{sessionId}`, denied to every client.
 *
 * The lookup by refresh token is the one query that needs it, and it runs
 * through the Admin SDK only.
 */

const SESSION_SECRETS = 'sessionSecrets';

export type SessionRecord = {
  id: string;
  userId: string;
  userAgent: string;
  deviceId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /**
   * Authentication methods proven for this session (RFC 8176 values):
   * 'pwd' password, 'otp' authenticator code, 'recovery' recovery code.
   * Kept on the ROW, not in the JWT, like the role: every request reads the
   * row anyway (see requireSession), so an upgrade or a revocation takes
   * effect on the next request instead of when a token expires.
   *
   * Rows written before this field existed read back without it and are
   * treated as [] - i.e. no second factor, which is the safe reading.
   */
  amr: string[];
  /** When a second factor was last proven on this session. */
  mfaAt: Date | null;
  /**
   * When the person actually signed in. NOT createdAt: every refresh rotates
   * the row, so createdAt means "last refreshed". This is carried across
   * rotation unchanged, which is what makes "signed in within the last ten
   * minutes" a meaningful re-authentication test (see lib/auth/reauth.ts).
   */
  authAt: Date;
};

const sessions = () => adminDb().collection(COLLECTIONS.sessions);
const secrets = () => adminDb().collection(SESSION_SECRETS);

export async function createSession(params: {
  id: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string;
  deviceId?: string | null;
  expiresAt: Date;
  amr: string[];
  mfaAt: Date | null;
  authAt: Date;
}): Promise<SessionRecord> {
  const now = new Date();
  const record = {
    userId: params.userId,
    userAgent: params.userAgent.slice(0, 512),
    deviceId: params.deviceId ?? null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: params.expiresAt,
    revokedAt: null,
    amr: params.amr,
    mfaAt: params.mfaAt,
    authAt: params.authAt,
  };

  const batch = adminDb().batch();
  batch.set(sessions().doc(params.id), forFirestore(record));
  batch.set(secrets().doc(params.id), { refreshTokenHash: params.refreshTokenHash });
  await batch.commit();

  return { id: params.id, ...record };
}

export async function findSessionById(id: string): Promise<SessionRecord | null> {
  const row = docToObject<SessionRecord>(await sessions().doc(id).get()) as SessionRecord | null;
  // Legacy rows predate amr/mfaAt; normalise here so no caller sees undefined.
  return row
    ? {
        ...row,
        amr: Array.isArray(row.amr) ? row.amr : [],
        mfaAt: row.mfaAt ?? null,
        // Legacy rows: createdAt is the best available (and an over-estimate
        // of recency never happens - it can only be later than the sign-in).
        authAt: row.authAt ?? row.createdAt,
      }
    : null;
}

/**
 * Records a second factor proven on an EXISTING session - enrollment, or a
 * step-up on a session that was issued before the account had one.
 *
 * Only a live session is upgraded: the update is conditional on the row still
 * being unrevoked, inside a transaction, so a session revoked a moment ago
 * cannot be resurrected into an MFA-verified one.
 */
export async function markSessionMfa(id: string, method: 'otp' | 'recovery', at: Date): Promise<boolean> {
  const ref = sessions().doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('revokedAt')) return false;
    const amr = Array.isArray(snap.get('amr')) ? (snap.get('amr') as string[]) : [];
    tx.update(ref, forFirestore({ amr: [...new Set([...amr, method])], mfaAt: at }));
    return true;
  });
}

/** Revokes every live session a user holds EXCEPT one - the one making the change. */
export async function revokeOtherUserSessions(userId: string, keepSessionId: string): Promise<number> {
  const snap = await sessions().where('userId', '==', userId).where('revokedAt', '==', null).get();
  const doomed = snap.docs.filter((doc) => doc.id !== keepSessionId);
  const now = new Date();
  for (let i = 0; i < doomed.length; i += 400) {
    const batch = adminDb().batch();
    for (const doc of doomed.slice(i, i + 400)) batch.update(doc.ref, forFirestore({ revokedAt: now }));
    await batch.commit();
  }
  return doomed.length;
}

/** Resolves a refresh token to its session, via the secrets collection. */
export async function findSessionByRefreshHash(hash: string): Promise<SessionRecord | null> {
  const snap = await secrets().where('refreshTokenHash', '==', hash).limit(1).get();
  if (snap.empty) return null;
  return findSessionById(snap.docs[0].id);
}

export async function revokeSessionById(id: string): Promise<void> {
  const existing = await sessions().doc(id).get();
  if (!existing.exists || existing.data()?.revokedAt) return;
  await sessions().doc(id).update(forFirestore({ revokedAt: new Date() }));
}

/**
 * Revokes every live session a user holds.
 *
 * Chunked into batches because Firestore caps a batch at 500 writes and a
 * long-lived account can accumulate more sessions than that - the E2E account
 * in this project already holds 249.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  const snap = await sessions().where('userId', '==', userId).where('revokedAt', '==', null).get();
  if (snap.empty) return 0;

  const now = new Date();
  let written = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = adminDb().batch();
    for (const doc of snap.docs.slice(i, i + 400)) {
      batch.update(doc.ref, forFirestore({ revokedAt: now }));
    }
    await batch.commit();
    written += Math.min(400, snap.docs.length - i);
  }
  return written;
}

/**
 * The account's unrevoked sessions. Equality-only (userId + revokedAt), the
 * same query revokeUserSessions() uses, so no composite index. Not "the latest
 * N rows": every token refresh rotates the row, so an active device would push
 * every other device off a recency-limited list.
 */
export async function listOpenUserSessions(userId: string): Promise<SessionRecord[]> {
  const snap = await sessions().where('userId', '==', userId).where('revokedAt', '==', null).get();
  return (docsToObjects<SessionRecord>(snap.docs) as SessionRecord[]).map((row) => ({
    ...row,
    authAt: row.authAt ?? row.createdAt,
  }));
}

/**
 * Revokes some of the account's own sessions - one device's worth, from the
 * Devices list. Rows that are not theirs or are already revoked are skipped,
 * inside the transaction, so a stale id can neither reach another account nor
 * move an existing revocation's timestamp. Returns how many were revoked.
 */
export async function revokeOwnSessions(userId: string, sessionIds: string[]): Promise<number> {
  const refs = [...new Set(sessionIds)].map((id) => sessions().doc(id));
  const now = new Date();
  let revoked = 0;
  // Chunked like revokeUserSessions: a transaction is capped at 500 writes, and
  // one browser that signs in over and over can hold more sessions than that.
  for (let i = 0; i < refs.length; i += 400) {
    revoked += await adminDb().runTransaction(async (tx) => {
      const snaps = await tx.getAll(...refs.slice(i, i + 400));
      const live = snaps.filter((snap) => snap.exists && snap.get('userId') === userId && !snap.get('revokedAt'));
      for (const snap of live) tx.update(snap.ref, forFirestore({ revokedAt: now }));
      return live.length;
    });
  }
  return revoked;
}

export async function touchSession(id: string, at: Date): Promise<void> {
  await sessions().doc(id).update(forFirestore({ lastSeenAt: at }));
}

export async function listUserSessions(userId: string, take = 20): Promise<SessionRecord[]> {
  const snap = await sessions().where('userId', '==', userId).get();
  const rows = docsToObjects<SessionRecord>(snap.docs) as SessionRecord[];
  // Sorted after the fact: ordering by createdAt alongside the userId equality
  // would need a composite index for a list that is at most a few hundred rows.
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take);
}

// ---------------------------------------------------------------------------

export type DeviceRecord = {
  id: string;
  userId: string;
  fingerprint: string;
  label: string | null;
  trusted: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

const devices = () => adminDb().collection(COLLECTIONS.userDevices);

export async function upsertDevice(params: {
  userId: string;
  fingerprint: string;
  label?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const snap = await devices()
    .where('userId', '==', params.userId)
    .where('fingerprint', '==', params.fingerprint)
    .limit(1)
    .get();

  const now = new Date();
  if (!snap.empty) {
    await snap.docs[0].ref.update(forFirestore({ lastSeenAt: now }));
    return { id: snap.docs[0].id, created: false };
  }

  const ref = devices().doc();
  await ref.set(
    forFirestore({
      userId: params.userId,
      fingerprint: params.fingerprint,
      label: params.label ?? null,
      trusted: false,
      firstSeenAt: now,
      lastSeenAt: now,
    }),
  );
  return { id: ref.id, created: true };
}

export async function listUserDevices(userId: string): Promise<DeviceRecord[]> {
  const snap = await devices().where('userId', '==', userId).get();
  const rows = docsToObjects<DeviceRecord>(snap.docs) as DeviceRecord[];
  return rows.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}
