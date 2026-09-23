import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import { open, seal } from '@/lib/crypto/vault';
import {
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotpInput,
  verifyTotp,
} from '@/lib/auth/totp';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, forFirestore } from '../convert';

/**
 * Second-factor state: `mfa/{userId}` and `loginTickets/{hash}`.
 *
 * ===========================================================================
 * EVERY CHECK AND ITS BOOKKEEPING SHARE ONE TRANSACTION
 * ===========================================================================
 * A second factor is only as strong as the counters around it, and each of
 * those counters is a read-modify-write that two parallel requests could race:
 *
 *  - REPLAY. `lastUsedStep` must move strictly forward. Two requests carrying
 *    the same code, checked outside a transaction, would both read the old
 *    step and both pass - one phished code, two sessions.
 *  - LOCKOUT. `failedCount` must count every wrong guess. Parallel guesses
 *    that each read "3 failures" and write "4" let an attacker fire far more
 *    than the ceiling.
 *  - RECOVERY CODES are single-use. Two requests with the same code must not
 *    both find it in the list before either removes it.
 *  - LOGIN TICKETS are single-use and allow five attempts, by the same logic.
 *
 * Firestore transactions are serialisable: if a document read inside one
 * changes before commit, the whole function re-runs against the new state. So
 * each check reads, decides and writes inside the same runTransaction, and
 * failures are RETURNED rather than thrown - a throw would roll back the very
 * failure counter it needs to record.
 *
 * ===========================================================================
 * THE SECRET IS SEALED, NOT HASHED
 * ===========================================================================
 * Verifying a TOTP code needs the secret itself, so it cannot be one-way
 * hashed like a password. It is sealed with the vault (AES-256-GCM) with
 * `{ userId, purpose: 'totp' }` as associated data: a sealed secret copied
 * into another user's document fails authentication on open() instead of
 * quietly verifying that user's codes.
 */

export type MfaRecord = {
  id: string;
  /** Active secret. Null until the first enrollment is confirmed. */
  totpSecretSealed: string | null;
  enrolledAt: Date | null;
  /**
   * An enrollment shown to the user but not yet proven with a code. It never
   * verifies a login. Replacing an authenticator leaves the OLD secret active
   * until the new one is confirmed, so an abandoned setup cannot lock anyone out.
   */
  pendingSecretSealed: string | null;
  pendingCreatedAt: Date | null;
  /** Highest TOTP time-step ever accepted. Codes at or below it are replays. */
  lastUsedStep: number;
  /** Keyed hashes of the unused recovery codes. */
  recoveryCodeHashes: string[];
  failedCount: number;
  lockedUntil: Date | null;
  updatedAt: Date;
};

/**
 * Wrong codes before the second factor locks. Deliberately independent of the
 * per-user rate limit in the routes: that one resets with its window, this one
 * is a hard ceiling that also holds against guesses spread across many IPs.
 */
const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;
/** An unconfirmed enrollment older than this is discarded. */
const PENDING_TTL_MS = 15 * 60_000;
const TICKET_TTL_MS = 5 * 60_000;
const TICKET_MAX_ATTEMPTS = 5;

const mfaDocs = () => adminDb().collection(COLLECTIONS.mfa);
const tickets = () => adminDb().collection(COLLECTIONS.loginTickets);

const sealContext = (userId: string) => ({ userId, purpose: 'totp' });
const hashRecovery = (canonical: string) => hashToken(`mfa-recovery:${canonical}`);
const hashUserAgent = (ua: string) => hashToken(`login-ticket-ua:${ua}`);

export function isEnrolled(record: MfaRecord | null): record is MfaRecord & { totpSecretSealed: string } {
  return !!record?.totpSecretSealed;
}

export async function getMfa(userId: string): Promise<MfaRecord | null> {
  return docToObject<MfaRecord>(await mfaDocs().doc(userId).get()) as MfaRecord | null;
}

function emptyRecord(now: Date): Omit<MfaRecord, 'id'> {
  return {
    totpSecretSealed: null,
    enrolledAt: null,
    pendingSecretSealed: null,
    pendingCreatedAt: null,
    lastUsedStep: 0,
    recoveryCodeHashes: [],
    failedCount: 0,
    lockedUntil: null,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Verification core
// ---------------------------------------------------------------------------

export type SecondFactorInput = { code?: string; recoveryCode?: string };
export type SecondFactorMethod = 'totp' | 'recovery';

export type SecondFactorResult =
  | { ok: true; method: SecondFactorMethod; recoveryCodesRemaining: number }
  | { ok: false; reason: 'not_enrolled' | 'locked' | 'invalid' };

/** Writes one failure, locking when the ceiling is reached. */
function recordFailure(tx: Transaction, ref: DocumentReference, record: MfaRecord, now: Date) {
  const failedCount = record.failedCount + 1;
  const locks = failedCount >= MAX_FAILURES;
  tx.update(
    ref,
    forFirestore({
      // Reset on lock, so the account gets a fresh allowance when it expires
      // rather than re-locking on the very next mistake.
      failedCount: locks ? 0 : failedCount,
      lockedUntil: locks ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : record.lockedUntil,
      updatedAt: now,
    }),
  );
}

/**
 * The single place a second factor is checked. Must be called inside a
 * transaction that has ALREADY read `record` through `tx` - Firestore requires
 * every read to precede the first write.
 */
function verifyInTransaction(
  tx: Transaction,
  ref: DocumentReference,
  record: MfaRecord | null,
  userId: string,
  input: SecondFactorInput,
  now: Date,
): SecondFactorResult {
  if (!isEnrolled(record)) return { ok: false, reason: 'not_enrolled' };
  // While locked, even a CORRECT code is refused - otherwise the lock would
  // only slow down an attacker who is already guessing right.
  if (record.lockedUntil && record.lockedUntil > now) return { ok: false, reason: 'locked' };

  // Truthiness, not `!== undefined`: the validators treat '' as absent, and a
  // body of { code, recoveryCode: '' } must be checked as the code it carries.
  if (input.recoveryCode) {
    const canonical = normalizeRecoveryCode(input.recoveryCode);
    const hash = canonical ? hashRecovery(canonical) : null;
    if (!hash || !record.recoveryCodeHashes.includes(hash)) {
      recordFailure(tx, ref, record, now);
      return { ok: false, reason: 'invalid' };
    }
    const remaining = record.recoveryCodeHashes.filter((h) => h !== hash);
    tx.update(ref, forFirestore({ recoveryCodeHashes: remaining, failedCount: 0, lockedUntil: null, updatedAt: now }));
    return { ok: true, method: 'recovery', recoveryCodesRemaining: remaining.length };
  }

  const code = normalizeTotpInput(input.code ?? '');
  const secret = open(record.totpSecretSealed, sealContext(userId));
  const step = verifyTotp(secret, code, now.getTime());
  secret.fill(0);

  // A code from a step already used is a replay, and counts as a failure: an
  // attacker replaying an observed code should spend attempts doing it.
  if (step === null || step <= record.lastUsedStep) {
    recordFailure(tx, ref, record, now);
    return { ok: false, reason: 'invalid' };
  }

  tx.update(ref, forFirestore({ lastUsedStep: step, failedCount: 0, lockedUntil: null, updatedAt: now }));
  return { ok: true, method: 'totp', recoveryCodesRemaining: record.recoveryCodeHashes.length };
}

/** Step-up / re-authentication for a signed-in user. */
export async function verifySecondFactor(userId: string, input: SecondFactorInput): Promise<SecondFactorResult> {
  const ref = mfaDocs().doc(userId);
  return adminDb().runTransaction(async (tx) => {
    const record = docToObject<MfaRecord>(await tx.get(ref)) as MfaRecord | null;
    return verifyInTransaction(tx, ref, record, userId, input, new Date());
  });
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

/**
 * Generates a fresh secret and stores it as PENDING. Returns the raw secret
 * so the route can render it once; it is never stored unsealed.
 *
 * Calling it again replaces the pending secret, which is what a user who
 * scanned the wrong QR code or closed the tab needs.
 */
export async function beginEnrollment(userId: string): Promise<Buffer> {
  const secret = newTotpSecret();
  const now = new Date();
  const ref = mfaDocs().doc(userId);
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const patch = { pendingSecretSealed: seal(secret, sealContext(userId)), pendingCreatedAt: now, updatedAt: now };
    if (snap.exists) tx.update(ref, forFirestore(patch));
    else tx.create(ref, forFirestore({ ...emptyRecord(now), ...patch }));
  });
  return secret;
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[]; replaced: boolean }
  | { ok: false; reason: 'no_pending' | 'expired' | 'locked' | 'invalid' };

/**
 * Proves possession of the pending secret and promotes it to active.
 *
 * A fresh set of recovery codes is issued with every confirmation, including a
 * replacement: codes printed for the previous authenticator may have been
 * stored alongside the phone that was lost.
 */
export async function confirmEnrollment(userId: string, rawCode: string): Promise<ConfirmResult> {
  const ref = mfaDocs().doc(userId);
  return adminDb().runTransaction(async (tx) => {
    const now = new Date();
    const record = docToObject<MfaRecord>(await tx.get(ref)) as MfaRecord | null;
    if (!record?.pendingSecretSealed || !record.pendingCreatedAt) return { ok: false, reason: 'no_pending' } as const;
    if (record.lockedUntil && record.lockedUntil > now) return { ok: false, reason: 'locked' } as const;

    if (now.getTime() - record.pendingCreatedAt.getTime() > PENDING_TTL_MS) {
      tx.update(ref, forFirestore({ pendingSecretSealed: null, pendingCreatedAt: null, updatedAt: now }));
      return { ok: false, reason: 'expired' } as const;
    }

    const secret = open(record.pendingSecretSealed, sealContext(userId));
    const step = verifyTotp(secret, normalizeTotpInput(rawCode), now.getTime());
    secret.fill(0);
    if (step === null) {
      recordFailure(tx, ref, record, now);
      return { ok: false, reason: 'invalid' } as const;
    }

    const recoveryCodes = newRecoveryCodes();
    tx.update(
      ref,
      forFirestore({
        totpSecretSealed: record.pendingSecretSealed,
        enrolledAt: now,
        pendingSecretSealed: null,
        pendingCreatedAt: null,
        // The step belongs to the NEW secret; the old secret's counter is
        // meaningless for it, so it is replaced rather than max()ed.
        lastUsedStep: step,
        recoveryCodeHashes: recoveryCodes.map((c) => hashRecovery(normalizeRecoveryCode(c)!)),
        failedCount: 0,
        lockedUntil: null,
        updatedAt: now,
      }),
    );
    return { ok: true, recoveryCodes, replaced: isEnrolled(record) } as const;
  });
}

/** Replaces every recovery code. The caller has already stepped up. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[] | null> {
  const ref = mfaDocs().doc(userId);
  return adminDb().runTransaction(async (tx) => {
    const record = docToObject<MfaRecord>(await tx.get(ref)) as MfaRecord | null;
    if (!isEnrolled(record)) return null;
    const codes = newRecoveryCodes();
    tx.update(
      ref,
      forFirestore({
        recoveryCodeHashes: codes.map((c) => hashRecovery(normalizeRecoveryCode(c)!)),
        updatedAt: new Date(),
      }),
    );
    return codes;
  });
}

/**
 * Removes the second factor entirely. Deleting the document (rather than
 * nulling fields) also discards the replay counter, which is correct: any
 * future enrollment has a new secret whose steps start from scratch.
 */
export async function removeMfa(userId: string): Promise<void> {
  await mfaDocs().doc(userId).delete();
}

// ---------------------------------------------------------------------------
// Login tickets
// ---------------------------------------------------------------------------

/**
 * "The password was right; the second factor is still owed."
 *
 * A ticket is NOT a session: it authorises exactly one thing, a call to
 * /api/auth/mfa/verify, and it is useless without the second factor. The
 * token goes back in the response body (never a cookie, so nothing else in
 * the app can mistake it for being signed in), and only its keyed hash is
 * stored, so a database read yields no usable ticket.
 *
 * Bound to the User-Agent it was issued to. That is not a strong binding - a
 * UA is easy to copy - but it costs nothing and turns a ticket lifted from a
 * log or a proxy into something that also needs the victim's exact browser
 * string.
 */
export type LoginTicket = {
  userId: string;
  uaHash: string;
  deviceFingerprint: string | null;
  /** Factors already proven when the ticket was issued, e.g. ['pwd']. */
  amr: string[];
  attempts: number;
  expiresAt: Date;
  createdAt: Date;
};

export async function createLoginTicket(params: {
  userId: string;
  userAgent: string;
  deviceFingerprint?: string;
  amr: string[];
}): Promise<{ token: string; expiresAt: Date }> {
  const token = newOpaqueToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TICKET_TTL_MS);
  await tickets()
    .doc(hashToken(token))
    .create(
      forFirestore({
        userId: params.userId,
        uaHash: hashUserAgent(params.userAgent),
        deviceFingerprint: params.deviceFingerprint ?? null,
        amr: params.amr,
        attempts: 0,
        expiresAt,
        createdAt: now,
      } satisfies LoginTicket),
    );
  return { token, expiresAt };
}

export type TicketResult =
  | {
      ok: true;
      userId: string;
      amr: string[];
      method: SecondFactorMethod;
      deviceFingerprint: string | null;
      recoveryCodesRemaining: number;
    }
  /** `userId` is set whenever the ticket itself was genuine - for the audit trail. */
  | { ok: false; reason: 'ticket' | 'not_enrolled' | 'locked' | 'invalid'; userId?: string };

/**
 * Redeems a ticket with a second factor, atomically.
 *
 * Ticket and MFA record are read in the same transaction, so the ticket is
 * consumed by exactly one successful call even if several arrive together -
 * two valid codes from adjacent time-steps must not mint two sessions.
 */
export async function redeemLoginTicket(params: {
  token: string;
  userAgent: string;
  input: SecondFactorInput;
}): Promise<TicketResult> {
  // A token of the wrong shape never reaches Firestore.
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.token)) return { ok: false, reason: 'ticket' };
  const ticketRef = tickets().doc(hashToken(params.token));

  return adminDb().runTransaction(async (tx) => {
    const now = new Date();
    const ticket = docToObject<LoginTicket & { id: string }>(await tx.get(ticketRef)) as
      | (LoginTicket & { id: string })
      | null;
    if (!ticket) return { ok: false, reason: 'ticket' } as const;

    const mfaRef = mfaDocs().doc(ticket.userId);
    const record = docToObject<MfaRecord>(await tx.get(mfaRef)) as MfaRecord | null;

    if (ticket.expiresAt <= now || ticket.uaHash !== hashUserAgent(params.userAgent)) {
      tx.delete(ticketRef);
      return { ok: false, reason: 'ticket' } as const;
    }

    const result = verifyInTransaction(tx, mfaRef, record, ticket.userId, params.input, now);

    if (result.ok) {
      tx.delete(ticketRef);
      return {
        ok: true,
        userId: ticket.userId,
        amr: [...new Set([...ticket.amr, result.method === 'totp' ? 'otp' : 'recovery'])],
        method: result.method,
        deviceFingerprint: ticket.deviceFingerprint,
        recoveryCodesRemaining: result.recoveryCodesRemaining,
      } as const;
    }

    // A ticket whose account has no second factor (removed after it was
    // issued) or whose factor is locked is finished: the client must start
    // again from the password, which re-evaluates everything.
    if (result.reason !== 'invalid' || ticket.attempts + 1 >= TICKET_MAX_ATTEMPTS) {
      tx.delete(ticketRef);
    } else {
      tx.update(ticketRef, { attempts: ticket.attempts + 1 });
    }
    return { ...result, userId: ticket.userId };
  });
}
