import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';
import type { ProviderProfile } from '@/lib/auth/oauth/providers';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const ids = await import('./identities');

const profile = (subject: string): ProviderProfile => ({
  provider: 'google',
  subject,
  email: 'aysel@gmail.com',
  emailVerified: true,
  linkableByEmail: true,
  firstName: null,
  lastName: null,
});

beforeEach(() => fake.store.clear());

describe('linkIdentity', () => {
  it('links once, and reports a repeat as already linked', async () => {
    expect(await ids.linkIdentity('u1', profile('g1'))).toBe('linked');
    expect(await ids.linkIdentity('u1', profile('g1'))).toBe('already_linked');
  });

  it('never re-points an identity owned by another user', async () => {
    await ids.linkIdentity('u1', profile('g1'));
    expect(await ids.linkIdentity('u2', profile('g1'))).toBe('identity_in_use');
    expect((await ids.findIdentity(ids.identityKey('google', 'g1')))?.userId).toBe('u1');
  });

  it('allows one account per provider per user', async () => {
    await ids.linkIdentity('u1', profile('g1'));
    expect(await ids.linkIdentity('u1', profile('g2'))).toBe('provider_already_linked');
  });

  it('stores neither the raw subject nor the full email', async () => {
    await ids.linkIdentity('u1', profile('g-subject-123'));
    const [[path, doc]] = [...fake.store.entries()];
    expect(path).not.toContain('g-subject-123');
    expect(JSON.stringify(doc)).not.toContain('aysel@gmail.com');
    expect(doc.emailHint).toBe('a****@gmail.com');
  });
});

describe('unlinkIdentity', () => {
  it('refuses to remove the last way into a password-less account', async () => {
    await fake.db.collection('credentials').doc('u1').set({ passwordHash: null });
    await ids.linkIdentity('u1', profile('g1'));
    expect(await ids.unlinkIdentity('u1', 'google')).toBe('last_method');
    expect(await ids.findIdentity(ids.identityKey('google', 'g1'))).not.toBeNull();
  });

  /**
   * With Google as the only provider, "another method" can only be a password.
   * That makes this the one path that unlinks: the account stays reachable.
   */
  it('removes google when the account still has a password', async () => {
    await fake.db.collection('credentials').doc('u1').set({ passwordHash: '$argon2id$...' });
    await ids.linkIdentity('u1', profile('g1'));
    expect(await ids.unlinkIdentity('u1', 'google')).toBe('unlinked');
    expect(await ids.findIdentity(ids.identityKey('google', 'g1'))).toBeNull();
  });

  it('reports a provider that is not linked', async () => {
    expect(await ids.unlinkIdentity('u1', 'google')).toBe('not_linked');
  });
});
