import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, forFirestore } from '../convert';
import { open, seal } from '@/lib/crypto/vault';

/**
 * A mentor's Google Calendar connection: what lets the platform create the
 * Google Meet room for an accepted session on the MENTOR's calendar, so the
 * mentor is the meeting's host and can admit their mentee.
 *
 * ===========================================================================
 * HOW THE TOKEN IS KEPT
 * ===========================================================================
 *  - Only the REFRESH token is stored, sealed with the vault (AES-256-GCM)
 *    and bound to this user and purpose as additional authenticated data, so
 *    a sealed value copied onto another user's document fails to open.
 *  - Access tokens are never stored: they are minted per use and cached in
 *    process memory for their hour (src/lib/google/calendar.ts).
 *  - The document is server-only (firestore.rules), keyed by user id, and
 *    deleted - with the token revoked at Google - on disconnect or account
 *    deletion. A token Google refuses (`invalid_grant`) flips the link to
 *    REVOKED, which is what the mentor panel shows as "reconnect".
 *  - The Google account's address is stored MASKED; it is only there so the
 *    mentor can recognise which account is connected.
 */

export type CalendarLinkStatus = 'ACTIVE' | 'REVOKED';

export type CalendarLinkRecord = {
  id: string;
  provider: 'google';
  status: CalendarLinkStatus;
  refreshTokenSealed: string;
  scope: string;
  /** Google's subject for the connected account; never shown. */
  googleSubject: string;
  /** e.g. "ma***@gmail.com". */
  accountHint: string | null;
  connectedAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

const links = () => adminDb().collection(COLLECTIONS.googleCalendarLinks);
const sealContext = (userId: string) => ({ purpose: 'google-calendar-refresh', userId });

export function maskAddress(email: string | null): string | null {
  if (!email) return null;
  const [user = '', domain = ''] = email.split('@');
  return domain ? `${user.slice(0, 2)}***@${domain}` : null;
}

export async function findCalendarLink(userId: string): Promise<CalendarLinkRecord | null> {
  return docToObject<CalendarLinkRecord>(await links().doc(userId).get()) as CalendarLinkRecord | null;
}

export function openRefreshToken(link: CalendarLinkRecord): string {
  return open(link.refreshTokenSealed, sealContext(link.id)).toString('utf8');
}

/**
 * Stores a fresh connection, replacing any earlier one. Returns the refresh
 * token it replaced (if any, and if different) so the caller can revoke it -
 * a reconnect must not leave the old grant alive at Google.
 */
export async function saveCalendarLink(
  userId: string,
  input: { refreshToken: string; scope: string; googleSubject: string; email: string | null },
): Promise<{ replacedToken: string | null }> {
  const previous = await findCalendarLink(userId);
  let replacedToken: string | null = null;
  if (previous) {
    try {
      const old = openRefreshToken(previous);
      if (old !== input.refreshToken) replacedToken = old;
    } catch {
      // Unopenable (vault key rotated): nothing to revoke from here.
    }
  }

  const now = new Date();
  await links()
    .doc(userId)
    .set(
      forFirestore({
        provider: 'google',
        status: 'ACTIVE',
        refreshTokenSealed: seal(Buffer.from(input.refreshToken, 'utf8'), sealContext(userId)),
        scope: input.scope,
        googleSubject: input.googleSubject,
        accountHint: maskAddress(input.email),
        connectedAt: now,
        updatedAt: now,
        revokedAt: null,
      } satisfies Omit<CalendarLinkRecord, 'id'>),
    );
  return { replacedToken };
}

/** Google refused the refresh token. Kept (not deleted) so the panel can say "reconnect". */
export async function markCalendarLinkRevoked(userId: string): Promise<boolean> {
  const ref = links().doc(userId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') === 'REVOKED') return false;
    const now = new Date();
    tx.update(ref, forFirestore({ status: 'REVOKED', revokedAt: now, updatedAt: now }));
    return true;
  });
}

/** Removes the connection and returns what was stored, for the caller to revoke at Google. */
export async function deleteCalendarLink(userId: string): Promise<CalendarLinkRecord | null> {
  const ref = links().doc(userId);
  return adminDb().runTransaction(async (tx) => {
    const found = docToObject<CalendarLinkRecord>(await tx.get(ref)) as CalendarLinkRecord | null;
    if (found) tx.delete(ref);
    return found;
  });
}
