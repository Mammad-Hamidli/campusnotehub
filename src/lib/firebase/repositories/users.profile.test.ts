import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const { completeProfile, renameUser, setInitialPassword } = await import('./users');

const finish = {
  fullName: 'Aysel Mammadova',
  firstName: 'Aysel',
  lastName: 'Mammadova',
  nickname: 'Aysel_M',
  universityId: 'uni-ada',
  passwordHash: '$argon2id$fake',
};

async function seedQuickAccount(id: string, handle: string, email = `${id}@gmail.com`) {
  await fake.db.collection('users').doc(id).set({ nickname: handle, nicknameLower: handle, email, profileIncomplete: true });
  await fake.db.collection('credentials').doc(id).set({ passwordHash: null, emailHash: `h:${email}` });
  await fake.db.collection('usernames').doc(handle).set({ userId: id });
}

beforeEach(async () => {
  fake.store.clear();
  await seedQuickAccount('u1', 'user34232');
});

describe('completeProfile', () => {
  it('swaps the temporary handle for the chosen one and lifts the view-only flag', async () => {
    expect(await completeProfile('u1', finish)).toBe('ok');
    expect(fake.store.get('users/u1')).toMatchObject({
      nickname: 'Aysel_M',
      nicknameLower: 'aysel_m',
      universityId: 'uni-ada',
      fullName: 'Aysel Mammadova',
      profileIncomplete: false,
    });
    // The local password is written in the same commit.
    expect(fake.store.get('credentials/u1')).toMatchObject({ passwordHash: '$argon2id$fake' });
    // The claim moved with it: the new one is held, the temporary one released.
    expect(fake.store.get('usernames/aysel_m')).toMatchObject({ userId: 'u1' });
    expect(fake.store.has('usernames/user34232')).toBe(false);
  });

  it('refuses a handle another account already holds, changing nothing', async () => {
    // The OWNER document matters now: a claim whose account is gone is a
    // leftover, not a clash - see liveOwners() in users.ts.
    await seedQuickAccount('someone-else', 'aysel_m', 'someone@gmail.com');
    expect(await completeProfile('u1', finish)).toBe('nickname');
    expect(fake.store.get('users/u1')).toMatchObject({ nickname: 'user34232', profileIncomplete: true });
    expect(fake.store.has('usernames/user34232')).toBe(true);
  });

  it('never renames an account that is already complete', async () => {
    await fake.db.collection('users').doc('u1').update({ profileIncomplete: false });
    expect(await completeProfile('u1', finish)).toBe('already_complete');
    expect(fake.store.get('users/u1')).toMatchObject({ nickname: 'user34232' });
  });

  it('stores an email for an account that had none, unless another account uses it', async () => {
    await seedQuickAccount('u2', 'user11111', 'u2@pending.invalid');
    await fake.db.collection('users').doc('u3').set({ email: 'taken@gmail.com', nicknameLower: 'x' });

    expect(
      await completeProfile('u2', { ...finish, nickname: 'second', email: { value: 'taken@gmail.com', hash: 'h:taken' } }),
    ).toBe('email');

    expect(
      await completeProfile('u2', { ...finish, nickname: 'second', email: { value: 'mine@gmail.com', hash: 'h:mine' } }),
    ).toBe('ok');
    expect(fake.store.get('users/u2')).toMatchObject({ email: 'mine@gmail.com', emailVerifiedAt: null });
    expect(fake.store.get('credentials/u2')).toMatchObject({ emailHash: 'h:mine', passwordHash: '$argon2id$fake' });
  });
});

describe('setInitialPassword', () => {
  it('sets the first password and clears the owed-password flag', async () => {
    await fake.db.collection('users').doc('u1').update({ passwordSetupRequired: true });
    expect(await setInitialPassword('u1', '$argon2id$first')).toBe('ok');
    expect(fake.store.get('credentials/u1')).toMatchObject({ passwordHash: '$argon2id$first' });
    expect(fake.store.get('users/u1')).toMatchObject({ passwordSetupRequired: false });
  });

  it('never overwrites an existing password', async () => {
    await fake.db.collection('credentials').doc('u1').update({ passwordHash: '$argon2id$old' });
    expect(await setInitialPassword('u1', '$argon2id$new')).toBe('already_set');
    expect(fake.store.get('credentials/u1')).toMatchObject({ passwordHash: '$argon2id$old' });
  });
});

describe('renameUser', () => {
  beforeEach(async () => {
    await fake.db.collection('users').doc('u1').update({ nickname: 'aysel', nicknameLower: 'aysel', profileIncomplete: false });
    await fake.db.collection('usernames').doc('aysel').set({ userId: 'u1' });
    fake.store.delete('usernames/user34232');
  });

  it('moves the profile and the claim together', async () => {
    expect(await renameUser('u1', 'Aysel_New')).toBe('ok');
    expect(fake.store.get('users/u1')).toMatchObject({ nickname: 'Aysel_New', nicknameLower: 'aysel_new' });
    expect(fake.store.get('usernames/aysel_new')).toMatchObject({ userId: 'u1' });
    expect(fake.store.has('usernames/aysel')).toBe(false);
  });

  it('refuses a handle another account holds, changing nothing', async () => {
    await seedQuickAccount('u9', 'taken');
    await fake.db.collection('users').doc('u9').update({ profileIncomplete: false });
    expect(await renameUser('u1', 'Taken')).toBe('nickname');
    expect(fake.store.get('users/u1')).toMatchObject({ nickname: 'aysel' });
    expect(fake.store.has('usernames/aysel')).toBe(true);
  });

  it('changes only the display case when the key is the same', async () => {
    expect(await renameUser('u1', 'AYSEL')).toBe('ok');
    expect(fake.store.get('users/u1')).toMatchObject({ nickname: 'AYSEL', nicknameLower: 'aysel' });
    expect(fake.store.get('usernames/aysel')).toMatchObject({ userId: 'u1' });
  });

  it('refuses an incomplete profile (that renames through completeProfile)', async () => {
    await fake.db.collection('users').doc('u1').update({ profileIncomplete: true });
    expect(await renameUser('u1', 'other')).toBe('incomplete');
  });
});
