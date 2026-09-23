import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The second-factor repository against an in-memory Firestore.
 *
 * The REAL repository runs - transactions, replay counter, lockout, single-use
 * recovery codes and tickets - with only the database client swapped. These
 * are the properties an attacker probes, so each one is asserted directly
 * rather than inferred from "the happy path works".
 *
 * The fake applies a transaction's writes after its callback returns, like
 * Firestore, so a failure that must be RECORDED (not thrown) is observable.
 * It does not simulate contention retries; the atomicity itself is
 * Firestore's guarantee, and what is tested here is that every check and its
 * bookkeeping sit inside one transaction.
 */

process.env.VAULT_KEY = 'test-vault-key-for-mfa-repository-tests-only';

type Data = Record<string, unknown>;
const store = new Map<string, Data>();
let autoId = 0;

function snapshot(path: string) {
  const data = store.get(path);
  return {
    exists: !!data,
    id: path.split('/').pop()!,
    data: () => (data ? structuredClone(data) : undefined),
    get: (field: string) => data?.[field],
  };
}

function ref(path: string) {
  return {
    path,
    id: path.split('/').pop()!,
    get: async () => snapshot(path),
    delete: async () => void store.delete(path),
    set: async (data: Data) => void store.set(path, structuredClone(data)),
    update: async (data: Data) => void store.set(path, { ...store.get(path)!, ...structuredClone(data) }),
    create: async (data: Data) => {
      if (store.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      store.set(path, structuredClone(data));
    },
  };
}
type Ref = ReturnType<typeof ref>;

const fakeDb = {
  collection: (name: string) => ({ doc: (id?: string) => ref(`${name}/${id ?? `auto${++autoId}`}`) }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const writes: (() => void)[] = [];
    const tx = {
      get: async (r: Ref) => snapshot(r.path),
      update: (r: Ref, data: Data) => writes.push(() => store.set(r.path, { ...store.get(r.path)!, ...structuredClone(data) })),
      set: (r: Ref, data: Data) => writes.push(() => store.set(r.path, structuredClone(data))),
      delete: (r: Ref) => writes.push(() => store.delete(r.path)),
      create: (r: Ref, data: Data) =>
        writes.push(() => {
          if (store.has(r.path)) throw new Error('ALREADY_EXISTS');
          store.set(r.path, structuredClone(data));
        }),
    };
    const result = await fn(tx);
    for (const write of writes) write();
    return result;
  },
};

vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fakeDb }));

const mfa = await import('./mfa');
const { hotp, totpStep } = await import('@/lib/auth/totp');

const USER = 'user_1';
const T0 = new Date('2026-09-21T10:00:00Z').getTime();
const codeAt = (secret: Buffer, ms: number) => hotp(secret, totpStep(ms));

async function enrolled(): Promise<{ secret: Buffer; recoveryCodes: string[] }> {
  const secret = await mfa.beginEnrollment(USER);
  const result = await mfa.confirmEnrollment(USER, codeAt(secret, Date.now()));
  if (!result.ok) throw new Error(`enrollment failed: ${result.reason}`);
  return { secret, recoveryCodes: result.recoveryCodes };
}

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('enrollment', () => {
  it('keeps a new secret pending until a code proves it, then issues recovery codes', async () => {
    const secret = await mfa.beginEnrollment(USER);
    expect(mfa.isEnrolled(await mfa.getMfa(USER))).toBe(false);

    const result = await mfa.confirmEnrollment(USER, codeAt(secret, T0));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recoveryCodes).toHaveLength(10);

    const record = await mfa.getMfa(USER);
    expect(mfa.isEnrolled(record)).toBe(true);
    expect(record?.pendingSecretSealed).toBeNull();
    // Nothing secret is stored in the clear.
    expect(JSON.stringify(store.get(`mfa/${USER}`))).not.toContain(secret.toString('base64'));
  });

  it('counts a wrong confirmation code as a failure', async () => {
    await mfa.beginEnrollment(USER);
    expect(await mfa.confirmEnrollment(USER, '000000')).toEqual({ ok: false, reason: 'invalid' });
    expect((await mfa.getMfa(USER))?.failedCount).toBe(1);
  });

  it('discards a pending secret older than 15 minutes', async () => {
    const secret = await mfa.beginEnrollment(USER);
    vi.setSystemTime(T0 + 16 * 60_000);
    expect(await mfa.confirmEnrollment(USER, codeAt(secret, Date.now()))).toEqual({ ok: false, reason: 'expired' });
    expect((await mfa.getMfa(USER))?.pendingSecretSealed).toBeNull();
  });

  it('keeps the old authenticator working until a replacement is confirmed', async () => {
    const { secret: oldSecret } = await enrolled();
    await mfa.beginEnrollment(USER); // started, never confirmed
    vi.setSystemTime(T0 + 60_000);
    expect((await mfa.verifySecondFactor(USER, { code: codeAt(oldSecret, Date.now()) })).ok).toBe(true);
  });

  it('reports a confirmed replacement as such and rotates the recovery codes', async () => {
    const first = await enrolled();
    const newSecret = await mfa.beginEnrollment(USER);
    vi.setSystemTime(T0 + 60_000);
    const result = await mfa.confirmEnrollment(USER, codeAt(newSecret, Date.now()));
    expect(result).toMatchObject({ ok: true, replaced: true });
    // Codes printed for the lost phone must stop working.
    expect(await mfa.verifySecondFactor(USER, { recoveryCode: first.recoveryCodes[0] })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('verifySecondFactor', () => {
  it('refuses an account with no second factor', async () => {
    expect(await mfa.verifySecondFactor(USER, { code: '123456' })).toEqual({ ok: false, reason: 'not_enrolled' });
  });

  it('refuses a replayed code, and any code from an older step', async () => {
    const { secret } = await enrolled();
    vi.setSystemTime(T0 + 30_000);
    const current = codeAt(secret, Date.now());

    expect((await mfa.verifySecondFactor(USER, { code: current })).ok).toBe(true);
    expect(await mfa.verifySecondFactor(USER, { code: current })).toEqual({ ok: false, reason: 'invalid' });
    // The previous step is still inside the drift window, but it is older than
    // the last accepted step, so it is a replay too.
    expect(await mfa.verifySecondFactor(USER, { code: codeAt(secret, Date.now() - 30_000) })).toEqual({
      ok: false,
      reason: 'invalid',
    });

    vi.setSystemTime(T0 + 60_000);
    expect((await mfa.verifySecondFactor(USER, { code: codeAt(secret, Date.now()) })).ok).toBe(true);
  });

  it('locks after ten wrong codes and then refuses even a correct one', async () => {
    const { secret } = await enrolled();
    for (let i = 0; i < 10; i++) await mfa.verifySecondFactor(USER, { code: '000000' });

    vi.setSystemTime(T0 + 30_000);
    expect(await mfa.verifySecondFactor(USER, { code: codeAt(secret, Date.now()) })).toEqual({
      ok: false,
      reason: 'locked',
    });

    vi.setSystemTime(T0 + 16 * 60_000);
    expect((await mfa.verifySecondFactor(USER, { code: codeAt(secret, Date.now()) })).ok).toBe(true);
  });

  it('accepts each recovery code exactly once, in any formatting', async () => {
    const { recoveryCodes } = await enrolled();
    const sloppy = recoveryCodes[3].toLowerCase().replace(/-/g, ' ');

    expect(await mfa.verifySecondFactor(USER, { recoveryCode: sloppy })).toEqual({
      ok: true,
      method: 'recovery',
      recoveryCodesRemaining: 9,
    });
    expect(await mfa.verifySecondFactor(USER, { recoveryCode: recoveryCodes[3] })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('checks the code, not an empty recoveryCode field sent alongside it', async () => {
    const { secret } = await enrolled();
    vi.setSystemTime(T0 + 30_000);
    const result = await mfa.verifySecondFactor(USER, { code: codeAt(secret, Date.now()), recoveryCode: '' });
    expect(result).toMatchObject({ ok: true, method: 'totp' });
  });

  it('cannot be satisfied by a sealed secret copied from another account', async () => {
    await enrolled();
    store.set('mfa/user_2', structuredClone(store.get(`mfa/${USER}`)!));
    // The vault's associated data binds the ciphertext to user_1.
    await expect(mfa.verifySecondFactor('user_2', { code: '123456' })).rejects.toThrow();
  });
});

describe('login tickets', () => {
  const UA = 'Mozilla/5.0 test';

  it('mints a session exactly once and records the factors proven', async () => {
    const { secret } = await enrolled();
    const { token } = await mfa.createLoginTicket({ userId: USER, userAgent: UA, amr: ['pwd'] });
    vi.setSystemTime(T0 + 30_000);
    const code = codeAt(secret, Date.now());

    const first = await mfa.redeemLoginTicket({ token, userAgent: UA, input: { code } });
    expect(first).toMatchObject({ ok: true, userId: USER, amr: ['pwd', 'otp'], method: 'totp' });
    expect(await mfa.redeemLoginTicket({ token, userAgent: UA, input: { code } })).toMatchObject({
      ok: false,
      reason: 'ticket',
    });
  });

  it('dies after five wrong codes', async () => {
    const { secret } = await enrolled();
    const { token } = await mfa.createLoginTicket({ userId: USER, userAgent: UA, amr: ['pwd'] });
    for (let i = 0; i < 5; i++) {
      expect(await mfa.redeemLoginTicket({ token, userAgent: UA, input: { code: '000000' } })).toMatchObject({
        reason: 'invalid',
        userId: USER,
      });
    }
    vi.setSystemTime(T0 + 30_000);
    expect(
      await mfa.redeemLoginTicket({ token, userAgent: UA, input: { code: codeAt(secret, Date.now()) } }),
    ).toMatchObject({ ok: false, reason: 'ticket' });
  });

  it('is refused from a different browser, and burned by the attempt', async () => {
    const { secret } = await enrolled();
    const { token } = await mfa.createLoginTicket({ userId: USER, userAgent: UA, amr: ['pwd'] });
    vi.setSystemTime(T0 + 30_000);
    const code = codeAt(secret, Date.now());
    expect(await mfa.redeemLoginTicket({ token, userAgent: 'curl/8', input: { code } })).toMatchObject({
      reason: 'ticket',
    });
    expect(await mfa.redeemLoginTicket({ token, userAgent: UA, input: { code } })).toMatchObject({ reason: 'ticket' });
  });

  it('expires after five minutes', async () => {
    const { secret } = await enrolled();
    const { token } = await mfa.createLoginTicket({ userId: USER, userAgent: UA, amr: ['pwd'] });
    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    expect(
      await mfa.redeemLoginTicket({ token, userAgent: UA, input: { code: codeAt(secret, Date.now()) } }),
    ).toMatchObject({ ok: false, reason: 'ticket' });
  });

  it('stores only a hash of the ticket', async () => {
    await enrolled();
    const { token } = await mfa.createLoginTicket({ userId: USER, userAgent: UA, amr: ['pwd'] });
    const paths = [...store.keys()].filter((p) => p.startsWith('loginTickets/'));
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toContain(token);
    expect(JSON.stringify(store.get(paths[0]))).not.toContain(token);
  });

  it('rejects a malformed token without touching the database', async () => {
    expect(await mfa.redeemLoginTicket({ token: '../mfa/user_1', userAgent: UA, input: { code: '123456' } })).toEqual({
      ok: false,
      reason: 'ticket',
    });
  });
});
