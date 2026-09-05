import { BlocklistType, type Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { hashEmail, hashPhone, piiHash } from '@/lib/crypto/hash';

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
  const candidates: Prisma.BlocklistWhereInput[] = [
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

  const hit = await db.blocklist.findFirst({
    where: {
      // Two independent conditions: the identifier matches one of ours AND the
      // block is still live. Nesting the expiry under its own AND keeps it from
      // being swallowed into the identifier OR, which would match every
      // unexpired row in the table.
      AND: [
        { OR: candidates },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      ],
    },
    select: { id: true, type: true },
  });

  if (!hit) return { blocked: false };

  // Hit counts drive the false-positive review dashboard: a device block with
  // 40 hits is almost certainly a shared lab machine and should be lifted.
  void db.blocklist
    .update({ where: { id: hit.id }, data: { hitCount: { increment: 1 } } })
    .catch(() => {});

  return { blocked: true, matchedType: hit.type };
}

/**
 * Applied when a MODERATOR confirms fraud. There is no automated caller -
 * see the note on `decide()` in src/lib/verification/policy.ts.
 */
export async function applyBan(params: {
  tx?: Prisma.TransactionClient;
  userId: string;
  moderatorId: string;
  reason: string;
  sourceCaseId?: string;
}): Promise<void> {
  const client = params.tx ?? db;

  const user = await client.user.findUniqueOrThrow({
    where: { id: params.userId },
    select: {
      emailHash: true,
      phoneHash: true,
      devices: { select: { fingerprint: true } },
    },
  });

  const deviceExpiry = new Date(Date.now() + DEVICE_BLOCK_DAYS * 86_400_000);

  const rows = [
    { type: BlocklistType.USER_ID, value: params.userId, expiresAt: null },
    { type: BlocklistType.EMAIL_HASH, value: user.emailHash, expiresAt: null },
    ...(user.phoneHash
      ? [{ type: BlocklistType.PHONE_HASH, value: user.phoneHash, expiresAt: null }]
      : []),
    // Only devices this account actually used. Never a device merely seen on
    // the same network - that is the IP-ban mistake wearing a different hat.
    ...user.devices.map((device) => ({
      type: BlocklistType.DEVICE_FINGERPRINT,
      value: device.fingerprint,
      expiresAt: deviceExpiry,
    })),
  ];

  await client.blocklist.createMany({
    data: rows.map((row) => ({
      ...row,
      reason: params.reason.slice(0, 500),
      sourceCaseId: params.sourceCaseId,
      createdById: params.moderatorId,
    })),
    skipDuplicates: true,
  });

  await client.user.update({
    where: { id: params.userId },
    data: {
      accountStatus: 'BANNED',
      verificationStatus: 'BANNED',
      isVerified: false,
    },
  });

  // Revoke live sessions so the ban takes effect now, not when the 15-minute
  // access token expires.
  await client.session.updateMany({
    where: { userId: params.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
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
  await db.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: params.userId },
      select: { emailHash: true, phoneHash: true, devices: { select: { fingerprint: true } } },
    });

    await tx.blocklist.deleteMany({
      where: {
        OR: [
          { type: BlocklistType.USER_ID, value: params.userId },
          { type: BlocklistType.EMAIL_HASH, value: user.emailHash },
          ...(user.phoneHash
            ? [{ type: BlocklistType.PHONE_HASH, value: user.phoneHash }]
            : []),
          {
            type: BlocklistType.DEVICE_FINGERPRINT,
            value: { in: user.devices.map((d) => d.fingerprint) },
          },
        ],
      },
    });

    await tx.user.update({
      where: { id: params.userId },
      data: { accountStatus: 'ACTIVE', verificationStatus: 'UNVERIFIED' },
    });

    await tx.moderationAction.create({
      data: {
        moderatorId: params.moderatorId,
        targetType: 'user',
        targetId: params.userId,
        action: 'unban',
        reason: params.reason,
      },
    });
  });
}

/**
 * Ring detection for the moderator dashboard.
 *
 * Answers "how many other accounts has this device been used by". A high count
 * is a signal worth a human look, never an automatic sanction: a university
 * computer lab legitimately produces dozens of accounts on one fingerprint,
 * and that is the exact false positive that makes automated device banning
 * unsafe.
 */
export async function relatedAccounts(fingerprint: string) {
  return db.userDevice.findMany({
    where: { fingerprint },
    select: {
      firstSeenAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          fullName: true,
          accountStatus: true,
          verificationStatus: true,
          createdAt: true,
        },
      },
    },
    orderBy: { firstSeenAt: 'asc' },
    take: 50,
  });
}

/** Records or refreshes a device against an account. */
export async function recordDevice(params: {
  userId: string;
  fingerprint: string;
  label: string;
}): Promise<string> {
  const device = await db.userDevice.upsert({
    where: { userId_fingerprint: { userId: params.userId, fingerprint: params.fingerprint } },
    create: { userId: params.userId, fingerprint: params.fingerprint, label: params.label },
    update: { lastSeenAt: new Date() },
    select: { id: true },
  });
  return device.id;
}

/** Used by the account-status middleware on every authenticated request. */
export async function isUserBlocked(userId: string): Promise<boolean> {
  const hit = await db.blocklist.findFirst({
    where: {
      type: BlocklistType.USER_ID,
      value: userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  return hit !== null;
}

export const hashDeviceValue = (raw: string) => piiHash(raw, 'device');
