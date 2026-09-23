import { piiHash } from '@/lib/crypto/hash';
import type { ProviderId, ProviderProfile } from '@/lib/auth/oauth/providers';
import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';

/**
 * Provider identities (Google accounts) linked to users.
 * (A first quick login creates its account directly - see quick-signup.ts.)
 *
 * ---------------------------------------------------------------------------
 * KEYED BY SUBJECT, NEVER BY EMAIL
 * ---------------------------------------------------------------------------
 * `authIdentities/{provider}:{hmac(subject)}`. The subject is the provider's
 * immutable account id; an email can be changed or recycled. The document id
 * makes "one provider account, one user" a hard constraint: two links racing
 * for the same Google account contend on one document and only one commits.
 *
 * The subject is HMAC'd with the server pepper rather than stored raw, so the
 * collection is not a directory of Google account ids.
 */

export type IdentityRecord = {
  id: string;
  userId: string;
  provider: ProviderId;
  /** Masked, for display only ("a***@gmail.com"). Never used to match. */
  emailHint: string | null;
  emailVerified: boolean;
  linkedAt: Date;
  lastUsedAt: Date;
};

const identities = () => adminDb().collection(COLLECTIONS.authIdentities);
const credentials = () => adminDb().collection('credentials');

export function identityKey(provider: ProviderId, subject: string): string {
  return `${provider}:${piiHash(subject, `oauth-subject:${provider}`)}`;
}

export const identityRef = (key: string) => identities().doc(key);

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local[0]}${'*'.repeat(Math.min(Math.max(local.length - 1, 1), 5))}@${domain}`;
}

/** The fields an identity document carries, minus userId (set by the writer). */
export function identityData(profile: ProviderProfile, now = new Date()) {
  return {
    provider: profile.provider,
    emailHint: maskEmail(profile.email),
    emailVerified: profile.emailVerified,
    linkedAt: now,
    lastUsedAt: now,
  };
}

export async function findIdentity(key: string): Promise<IdentityRecord | null> {
  return docToObject<IdentityRecord>(await identities().doc(key).get()) as IdentityRecord | null;
}

export async function listIdentities(userId: string): Promise<IdentityRecord[]> {
  const snap = await identities().where('userId', '==', userId).get();
  return docsToObjects<IdentityRecord>(snap.docs) as IdentityRecord[];
}

export async function touchIdentity(key: string): Promise<void> {
  await identities().doc(key).update(forFirestore({ lastUsedAt: new Date() }));
}

export type LinkResult = 'linked' | 'already_linked' | 'identity_in_use' | 'provider_already_linked';

/**
 * Links a provider account to a user. Never re-points an identity that
 * belongs to someone else: "this Google account is already used by another
 * account" is an error for a person to resolve, not a merge to perform.
 *
 * One identity per provider per user, so "connected with Google" always
 * means one specific Google account the person can see and remove.
 */
export async function linkIdentity(userId: string, profile: ProviderProfile): Promise<LinkResult> {
  const ref = identities().doc(identityKey(profile.provider, profile.subject));
  return adminDb().runTransaction(async (tx) => {
    const [existing, sameProvider] = await Promise.all([
      tx.get(ref),
      tx.get(identities().where('userId', '==', userId).where('provider', '==', profile.provider).limit(1)),
    ]);
    if (existing.exists) return existing.get('userId') === userId ? 'already_linked' : 'identity_in_use';
    if (!sameProvider.empty) return 'provider_already_linked';
    tx.create(ref, forFirestore({ ...identityData(profile), userId }));
    return 'linked';
  });
}

export type UnlinkResult = 'unlinked' | 'not_linked' | 'last_method';

/**
 * Removes a provider from an account - unless it is the account's LAST way
 * to sign in. An account with no password and no other identity would be
 * unreachable by its owner, which is a lockout the owner performed by
 * accident; the check and the delete share a transaction so two parallel
 * unlinks cannot each see "one other method left" and remove both.
 */
export async function unlinkIdentity(userId: string, provider: ProviderId): Promise<UnlinkResult> {
  return adminDb().runTransaction(async (tx) => {
    const [mine, credential] = await Promise.all([
      tx.get(identities().where('userId', '==', userId)),
      tx.get(credentials().doc(userId)),
    ]);
    const target = mine.docs.filter((d) => d.get('provider') === provider);
    if (target.length === 0) return 'not_linked';
    const hasPassword = typeof credential.get('passwordHash') === 'string';
    if (!hasPassword && mine.docs.length - target.length === 0) return 'last_method';
    for (const doc of target) tx.delete(doc.ref);
    return 'unlinked';
  });
}
