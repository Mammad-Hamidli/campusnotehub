import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const { createUser, DuplicateUserError } = await import('./users');

const BASE = {
  email: 'aysel@gmail.com',
  phone: '+994501234567',
  fullName: 'Aysel Mammadova',
  nickname: 'aysel_m',
  locale: 'az',
  role: 'STUDENT',
  accountStatus: 'ACTIVE',
  verificationStatus: 'UNVERIFIED',
  deletedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
} as const;

function signup(overrides: Partial<Record<string, unknown>> = {}) {
  const profile = { ...BASE, id: 'new-user', ...overrides } as never;
  return createUser({
    profile,
    credentials: {
      passwordHash: '$argon2id$x',
      emailHash: `h:${(overrides.email as string) ?? BASE.email}`,
      phoneHash: `p:${(overrides.phone as string) ?? BASE.phone}`,
    },
  });
}

/** A complete account: profile, credentials and claim, the way createUser writes one. */
async function seedAccount(id: string, email: string, phone: string, handle: string) {
  await fake.db.collection('users').doc(id).set({ ...BASE, id, email, phone, nickname: handle, nicknameLower: handle });
  await fake.db.collection('credentials').doc(id).set({ passwordHash: 'x', emailHash: `h:${email}`, phoneHash: `p:${phone}` });
  await fake.db.collection('usernames').doc(handle).set({ userId: id, createdAt: new Date() });
}

beforeEach(() => {
  fake.store.clear();
});

describe('createUser uniqueness', () => {
  it('creates the account, its credentials and its claim in one go', async () => {
    const user = await createUser({
      profile: { ...BASE, id: 'new-user' } as never,
      credentials: { passwordHash: 'x', emailHash: 'h:aysel@gmail.com', phoneHash: 'p:+994501234567' },
    });
    expect(user.id).toBe('new-user');
    expect(fake.store.get('credentials/new-user')).toMatchObject({ emailHash: 'h:aysel@gmail.com' });
    expect(fake.store.get('usernames/aysel_m')).toMatchObject({ userId: 'new-user' });
  });

  it('refuses an email a live account holds', async () => {
    await seedAccount('u1', 'aysel@gmail.com', '+994555555555', 'someone');
    await expect(signup()).rejects.toMatchObject({ fields: ['email'] });
  });

  it('refuses a phone a live account holds', async () => {
    await seedAccount('u1', 'other@gmail.com', '+994501234567', 'someone');
    await expect(signup()).rejects.toMatchObject({ fields: ['phone'] });
  });

  /**
   * The granular-errors bug: the old code threw on the first failed check, so
   * a submit whose email AND phone were both taken only ever reported the
   * email, and the second problem surfaced on the next attempt.
   */
  it('reports every clashing field from one attempt', async () => {
    await seedAccount('u1', 'aysel@gmail.com', '+994555555555', 'first');
    await seedAccount('u2', 'other@gmail.com', '+994501234567', 'second');
    await seedAccount('u3', 'third@gmail.com', '+994557777777', 'aysel_m');

    const error = await signup().catch((e) => e);
    expect(error).toBeInstanceOf(DuplicateUserError);
    expect(error.fields).toEqual(['email', 'phone', 'nickname']);
    // `field` stays the first clash for callers that only handle one.
    expect(error.field).toBe('email');
  });

  /**
   * The false-positive bug. `credentials` and `usernames` are separate
   * top-level collections with no cascade, so emptying `users` leaves them
   * behind - and they used to refuse every signup that reused the address,
   * with an error no amount of clearing `users` could shift.
   */
  it('ignores credentials left behind by a deleted account, and purges them', async () => {
    await seedAccount('ghost', 'aysel@gmail.com', '+994501234567', 'ghost_handle');
    await fake.db.collection('users').doc('ghost').delete();

    const user = await signup();
    expect(user.id).toBe('new-user');
    expect(fake.store.has('credentials/ghost')).toBe(false);
  });

  it('ignores a username claim left behind by a deleted account', async () => {
    await seedAccount('ghost', 'other@gmail.com', '+994555555555', 'aysel_m');
    await fake.db.collection('users').doc('ghost').delete();

    const user = await signup();
    expect(user.id).toBe('new-user');
    expect(fake.store.get('usernames/aysel_m')).toMatchObject({ userId: 'new-user' });
  });

  /**
   * The other half of the same rule: a leftover must not block, but a
   * soft-deleted account still must. Its `users` document is still there, so
   * its address and number stay spoken for and cannot be recycled.
   */
  it('still refuses an identifier a soft-deleted account holds', async () => {
    await seedAccount('u1', 'aysel@gmail.com', '+994501234567', 'someone');
    await fake.db.collection('users').doc('u1').update({ deletedAt: new Date(), accountStatus: 'DELETED' });

    await expect(signup()).rejects.toMatchObject({ fields: ['email', 'phone'] });
  });

  it('does not block on a phone when the account has none', async () => {
    await fake.db.collection('users').doc('u1').set({ ...BASE, id: 'u1', email: 'x@gmail.com', nicknameLower: 'x' });
    await fake.db.collection('credentials').doc('u1').set({ passwordHash: null, emailHash: 'h:x@gmail.com', phoneHash: null });

    const user = await createUser({
      profile: { ...BASE, id: 'new-user' } as never,
      credentials: { passwordHash: null, emailHash: 'h:aysel@gmail.com', phoneHash: null },
    });
    expect(user.id).toBe('new-user');
  });
});
