import { BlocklistType } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { docsToObjects, forFirestore } from '@/lib/firebase/convert';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { upsertDevice, listUserDevices, revokeUserSessions } from '@/lib/firebase/repositories/sessions';
import { getCredentials } from '@/lib/firebase/repositories/users';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * `type` + `value` was a UNIQUE pair in SQL, so it becomes the document id.
 *
 * That turns every blocklist check into a direct read instead of a query, and
 * makes a repeated ban idempotent for free. The value is hashed for every PII
 * type before it reaches here, so the id encodes no readable identifier - but
 * it is still encoded, because a raw HMAC can contain characters Firestore
 * forbids in a document id (notably '/').
 */
function blocklistDoc(type: string, value: string) {
  const id = `${type}__${Buffer.from(value).toString('base64url')}`;
  return adminDb().collection(COLLECTIONS.blocklist).doc(id);
}
import { hashEmail, hashPhone } from '@/lib/crypto/hash';

/**
 * Account- and device-level ban enforcement.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY MISSING: IP ADDRESSES
 * ---------------------------------------------------------------------------
 * There is no function in this file that accepts an IP address, and
 * BlocklistType has no network member. This is the fix for the single worst
 * flaw in the previous design.
 *
 * Concretely, in this market: student dormitories and university campuses sit
 * behind a handful of NAT'd public addresses, and every Azerbaijani mobile
 * carrier uses CGNAT, so one IPv4 address routinely fronts thousands of
 * people. Banning an IP after one forged student card takes out an entire
 * dormitory - and the person who forged the card reconnects on mobile data
 * thirty seconds later. It is collateral damage with no upside.
 *
 * IP addresses are still used for RATE LIMITING, which is a different thing:
 * rate limiting is temporary, applies to a burst, and recovers by itself.
 * See src/lib/security/ratelimit.ts.
 *
 * How long each identifier stays blocked:
 *
 *   USER_ID            permanent   the actual offender
 *   EMAIL_HASH         permanent   cheap to rotate, but raises cost
 *   PHONE_HASH         permanent   the strongest of the four - SIM
 *                                  registration in AZ is identity-linked
 *   DEVICE_FINGERPRINT expiring    fingerprints collide and get inherited by
 *                                  second-hand phones; a CHECK constraint in
 *                                  0002_zero_retention.sql refuses to accept
 *                                  a device block without an expiry
 */

const DEVICE_BLOCK_DAYS = Number(process.env.DEVICE_BLOCK_TTL_DAYS ?? 180);

export type BlockCheck = {
  blocked: boolean;
  /** Never surfaced to the user - for moderator tooling and audit only. */
  matchedType?: BlocklistType;
};

/**
 * Signup gate. Every value is hashed before it reaches the query, so the
 * blocklist table never contains a readable email or phone number.
 */
export async function checkSignupBlocked(input: {
  email: string;
  phone?: string;
  deviceFingerprint?: string;
}): Promise<BlockCheck> {
  const candidates: { type: BlocklistType; value: string }[] = [
    { type: BlocklistType.EMAIL_HASH, value: hashEmail(input.email) },
  ];

  if (input.phone) {
    candidates.push({ type: BlocklistType.PHONE_HASH, value: hashPhone(input.phone) });
  }
  if (input.deviceFingerprint) {
    candidates.push({
      type: BlocklistType.DEVICE_FINGERPRINT,
      value: input.deviceFingerprint,
    });
  }

  /**
   * One lookup per candidate, by DETERMINISTIC DOCUMENT ID.
   *
   * The SQL version was a single query with an OR over the candidate list.
   * Firestore has no OR across different field values, but it does not need
   * one here: `type` + `value` was already a UNIQUE pair, so it becomes the
   * document id and each check is a direct read rather than a query. That is
   * strictly cheaper than the OR it replaces.
   *
   * The expiry is evaluated after the read, not in the query, because a null
   * expiry means "permanent" and Firestore cannot express "null OR greater
   * than now" in one filter.
   */
  const now = new Date();
  const refs = candidates.map((c) => blocklistDoc(c.type, c.value));
  const snaps = await adminDb().getAll(...refs);

  type BlockRow = { id: string; type: BlocklistType; expiresAt?: { toDate(): Date } | Date | null };

  const hit = snaps
    .map((snap) =>
      snap.exists
        ? ({ id: snap.id, ...(snap.data() as Record<string, unknown>) } as unknown as BlockRow)
        : null,
    )
    .find((row): row is BlockRow => {
      if (!row) return false;
      const expiresAt = row.expiresAt;
      if (!expiresAt) return true; // permanent
      const asDate = expiresAt instanceof Date ? expiresAt : expiresAt.toDate();
      return asDate > now;
    });

  if (!hit) return { blocked: false };

  // Hit counts drive the false-positive review dashboard: a device block with
  // 40 hits is almost certainly a shared lab machine and should be lifted.
  void adminDb()
    .collection(COLLECTIONS.blocklist)
    .doc(hit.id)
    .update({ hitCount: FieldValue.increment(1) })
    .catch(() => {});

  return { blocked: true, matchedType: hit.type };
}

/**
 * Applied when a MODERATOR confirms fraud. There is no automated caller -
 * see the note on `decide()` in src/lib/verification/policy.ts.
 */
export async function applyBan(params: {
  userId: string;
  moderatorId: string;
  reason: string;
  sourceCaseId?: string;
}): Promise<void> {
  /**
   * A BATCH, not a transaction.
   *
   * The SQL version ran inside the caller's transaction so the blocklist rows,
   * the status change and the session revocation committed together. Firestore
   * batches are also atomic, and this needs no read-modify-write - every write
   * is an unconditional set - so a batch gives the same all-or-nothing
   * guarantee without a transaction's retry semantics.
   *
   * The `tx` parameter is gone: Firestore transactions cannot be nested and
   * cannot be passed across module boundaries the way a Prisma client can.
   * Callers that used to pass one now call this directly, and the atomicity
   * they wanted is provided here.
   */
  const [credential, devices] = await Promise.all([
    getCredentials(params.userId),
    listUserDevices(params.userId),
  ]);

  if (!credential) throw new Error(`no credentials for user ${params.userId}`);

  const deviceExpiry = new Date(Date.now() + DEVICE_BLOCK_DAYS * 86_400_000);

  const rows = [
    { type: BlocklistType.USER_ID, value: params.userId, expiresAt: null as Date | null },
    { type: BlocklistType.EMAIL_HASH, value: credential.emailHash, expiresAt: null as Date | null },
    ...(credential.phoneHash
      ? [{ type: BlocklistType.PHONE_HASH, value: credential.phoneHash, expiresAt: null as Date | null }]
      : []),
    // Only devices this account actually used. Never a device merely seen on
    // the same network - that is the IP-ban mistake wearing a different hat.
    ...devices.map((device) => ({
      type: BlocklistType.DEVICE_FINGERPRINT,
      value: device.fingerprint,
      expiresAt: deviceExpiry,
    })),
  ];

  const batch = adminDb().batch();

  for (const row of rows) {
    // `type` + `value` was UNIQUE in SQL, so it becomes the document id.
    // A repeated ban therefore overwrites its own row instead of duplicating,
    // which is what `skipDuplicates` bought before.
    batch.set(
      blocklistDoc(row.type, row.value),
      forFirestore({
        type: row.type,
        value: row.value,
        expiresAt: row.expiresAt,
        reason: params.reason.slice(0, 500),
        sourceCaseId: params.sourceCaseId ?? null,
        createdById: params.moderatorId,
        hitCount: 0,
        createdAt: new Date(),
      }),
    );
  }

  batch.update(adminDb().collection(COLLECTIONS.users).doc(params.userId), {
    accountStatus: 'BANNED',
    verificationStatus: 'BANNED',
    isVerified: false,
    updatedAt: new Date(),
  });

  await batch.commit();

  // Revoke live sessions so the ban takes effect now, not when the access
  // token expires. Outside the batch because the session count is unbounded
  // and would blow the 500-write ceiling on a long-lived account.
  await revokeUserSessions(params.userId);
}

/**
 * Lifts a ban. Removes the expiring device blocks and the account-identifier
 * blocks, but keeps the audit trail - `ModerationAction` rows are never
 * deleted, so an unban is as reviewable as the ban was.
 */
export async function liftBan(params: {
  userId: string;
  moderatorId: string;
  reason: string;
}): Promise<void> {
  const [credential, devices] = await Promise.all([
    getCredentials(params.userId),
    listUserDevices(params.userId),
  ]);
  if (!credential) throw new Error(`no credentials for user ${params.userId}`);

  const batch = adminDb().batch();

  // Deleting by deterministic id needs no query - the same ids applyBan wrote.
  batch.delete(blocklistDoc(BlocklistType.USER_ID, params.userId));
  batch.delete(blocklistDoc(BlocklistType.EMAIL_HASH, credential.emailHash));
  if (credential.phoneHash) {
    batch.delete(blocklistDoc(BlocklistType.PHONE_HASH, credential.phoneHash));
  }
  for (const device of devices) {
    batch.delete(blocklistDoc(BlocklistType.DEVICE_FINGERPRINT, device.fingerprint));
  }

  batch.update(adminDb().collection(COLLECTIONS.users).doc(params.userId), {
    accountStatus: 'ACTIVE',
    verificationStatus: 'UNVERIFIED',
    updatedAt: new Date(),
  });

  // The ModerationAction row is NOT deleted: an unban must stay as reviewable
  // as the ban was.
  batch.set(
    adminDb().collection(COLLECTIONS.moderationActions).doc(),
    forFirestore({
      moderatorId: params.moderatorId,
      targetType: 'user',
      targetId: params.userId,
      action: 'unban',
      reason: params.reason,
      createdAt: new Date(),
    }),
  );

  await batch.commit();
}

export async function relatedAccounts(fingerprint: string) {
  const snap = await adminDb()
    .collection(COLLECTIONS.userDevices)
    .where('fingerprint', '==', fingerprint)
    .limit(50)
    .get();

  const devices = docsToObjects<{
    id: string;
    userId: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
  }>(snap.docs);

  // The user decoration that Prisma did with a relation include becomes one
  // batched read here, not a query per device.
  const users = await findUsersByIds(devices.map((d) => d.userId));

  return devices
    .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())
    .map((device) => {
      const user = users.get(device.userId);
      return {
        firstSeenAt: device.firstSeenAt,
        lastSeenAt: device.lastSeenAt,
        user: user
          ? {
              id: user.id,
              fullName: user.fullName,
              accountStatus: user.accountStatus,
              verificationStatus: user.verificationStatus,
              createdAt: user.createdAt,
            }
          : null,
      };
    });
}

/** Records or refreshes a device against an account. */
export async function recordDevice(params: {
  userId: string;
  fingerprint: string;
  label: string;
}): Promise<string> {
  return (await recordDeviceDetailed(params)).id;
}

/** Same, and also says whether this device was seen for the first time. */
export async function recordDeviceDetailed(params: {
  userId: string;
  fingerprint: string;
  label: string;
}): Promise<{ id: string; created: boolean }> {
  return upsertDevice({
    userId: params.userId,
    fingerprint: params.fingerprint,
    label: params.label,
  });
}

/** Used by the account-status middleware on every authenticated request. */
export async function isUserBlocked(userId: string): Promise<boolean> {
  const snap = await blocklistDoc(BlocklistType.USER_ID, userId).get();
  if (!snap.exists) return false;
  const expiresAt = snap.data()?.expiresAt as { toDate(): Date } | Date | null | undefined;
  if (!expiresAt) return true;
  const asDate = expiresAt instanceof Date ? expiresAt : expiresAt.toDate();
  return asDate > new Date();
}

