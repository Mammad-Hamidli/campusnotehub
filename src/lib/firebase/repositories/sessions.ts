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
  };

  const batch = adminDb().batch();
  batch.set(sessions().doc(params.id), forFirestore(record));
  batch.set(secrets().doc(params.id), { refreshTokenHash: params.refreshTokenHash });
  await batch.commit();

  return { id: params.id, ...record };
}

export async function findSessionById(id: string): Promise<SessionRecord | null> {
  return docToObject<SessionRecord>(await sessions().doc(id).get()) as SessionRecord | null;
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
