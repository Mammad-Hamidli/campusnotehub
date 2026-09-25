import { hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, forFirestore } from '../convert';

/**
 * QR sign-in ("link a device"): `deviceLinks/{hash(token)}`.
 *
 * A signed-in browser, after proving it is still its owner, mints a token and
 * shows it as a QR code. Whoever opens it on another device and confirms gets
 * a session of their own - the WhatsApp Web idea with the roles reversed.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A SCREEN-SIZED CREDENTIAL ACCEPTABLE
 * ---------------------------------------------------------------------------
 *  - Two minutes, single use, consumed inside a transaction: two scans
 *    racing each other mint one session, not two.
 *  - Only the HMAC is stored, like every other token here. The document id is
 *    that hash, which is also the handle the issuing browser polls with - it
 *    is useless for signing in, since redemption needs the preimage.
 *  - Bound to the issuing SESSION, not just the account: signing that browser
 *    out (or it idling out) kills an unscanned code with it.
 *  - The issuer can cancel it, and closing the dialog does.
 *
 * Server-only (rules deny every client); TTL policy on expiresAt.
 */

const LINK_TTL_MS = 2 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const ID_SHAPE = /^[a-f0-9]{64}$/;

export type DeviceLinkRecord = {
  id: string;
  userId: string;
  issuedBySessionId: string;
  /** Factors the new session will carry - decided at issue time; see the route. */
  amr: string[];
  mfaAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  linkedAt: Date | null;
  linkedUserAgent: string | null;
};

export type DeviceLinkStatus =
  | { state: 'pending'; expiresAt: Date }
  | { state: 'linked'; linkedAt: Date; userAgent: string }
  | { state: 'expired' };

type IssuerRow = { revokedAt: Date | null; expiresAt: Date; lastSeenAt: Date };

const links = () => adminDb().collection(COLLECTIONS.deviceLinks);

export async function createDeviceLink(params: {
  userId: string;
  sessionId: string;
  amr: string[];
  mfaAt: Date | null;
}): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = newOpaqueToken();
  const id = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await links()
    .doc(id)
    .create(
      forFirestore({
        userId: params.userId,
        issuedBySessionId: params.sessionId,
        amr: params.amr,
        mfaAt: params.mfaAt,
        createdAt: now,
        expiresAt,
        linkedAt: null,
        linkedUserAgent: null,
      } satisfies Omit<DeviceLinkRecord, 'id'>),
    );
  return { token, id, expiresAt };
}

/** The issuer's view of its own link; null when it is not this account's. */
export async function getDeviceLinkStatus(userId: string, id: string): Promise<DeviceLinkStatus | null> {
  if (!ID_SHAPE.test(id)) return null;
  const link = docToObject<DeviceLinkRecord>(await links().doc(id).get()) as DeviceLinkRecord | null;
  if (!link || link.userId !== userId) return null;
  if (link.linkedAt) return { state: 'linked', linkedAt: link.linkedAt, userAgent: link.linkedUserAgent ?? '' };
  return link.expiresAt > new Date() ? { state: 'pending', expiresAt: link.expiresAt } : { state: 'expired' };
}

/** Withdraws an unscanned link. A redeemed one is left as the record of what happened. */
export async function cancelDeviceLink(userId: string, id: string): Promise<void> {
  if (!ID_SHAPE.test(id)) return;
  const ref = links().doc(id);
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('userId') === userId && !snap.get('linkedAt')) tx.delete(ref);
  });
}

/**
 * The account a still-usable link would sign in to, WITHOUT consuming it - so
 * the scanning device can show "Sign in as @nickname?" first. That screen is
 * what stops a code someone ELSE generated (sent as a link, or printed on a
 * poster) from silently signing a victim into the sender's account.
 */
export async function peekDeviceLink(token: string): Promise<string | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const link = docToObject<DeviceLinkRecord>(await links().doc(hashToken(token)).get()) as DeviceLinkRecord | null;
  return link && !link.linkedAt && link.expiresAt > new Date() ? link.userId : null;
}

export type RedeemResult =
  | { ok: true; userId: string; amr: string[]; mfaAt: Date | null }
  /** `userId` is set whenever the token itself was genuine - for the audit trail. */
  | { ok: false; userId?: string };

/**
 * Consumes a link, atomically. The issuing session is read in the same
 * transaction: a code whose browser has since signed out is dead even inside
 * its two minutes. `issuerIsLive` is the session module's own liveness rule,
 * passed in so this repository does not import the auth layer.
 */
export async function redeemDeviceLink(params: {
  token: string;
  userAgent: string;
  issuerIsLive: (row: IssuerRow) => boolean;
}): Promise<RedeemResult> {
  if (!TOKEN_SHAPE.test(params.token)) return { ok: false };
  const ref = links().doc(hashToken(params.token));

  return adminDb().runTransaction(async (tx) => {
    const now = new Date();
    const link = docToObject<DeviceLinkRecord>(await tx.get(ref)) as DeviceLinkRecord | null;
    if (!link) return { ok: false } as const;
    if (link.linkedAt || link.expiresAt <= now) return { ok: false, userId: link.userId } as const;

    const issuerRef = adminDb().collection(COLLECTIONS.sessions).doc(link.issuedBySessionId);
    const issuer = docToObject<IssuerRow & { userId: string }>(await tx.get(issuerRef));
    if (!issuer || issuer.userId !== link.userId || !params.issuerIsLive(issuer)) {
      tx.delete(ref);
      return { ok: false, userId: link.userId } as const;
    }

    tx.update(ref, forFirestore({ linkedAt: now, linkedUserAgent: params.userAgent.slice(0, 512) }));
    return { ok: true, userId: link.userId, amr: link.amr, mfaAt: link.mfaAt } as const;
  });
}
