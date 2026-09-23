import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

/**
 * The authorization flow with real crypto: PKCE, single-use state, browser
 * binding, and id_token verification against a locally generated key served
 * as the provider's JWKS.
 */

process.env.VAULT_KEY = 'test-vault-key-for-oauth-flow-tests-only';
const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

/**
 * jose's remote key set fetches over node:https, not fetch, so the provider's
 * JWKS endpoint is replaced by a local key set holding the test key. Only the
 * key SOURCE is swapped; signature verification is jose's real code.
 */
const providerKeys: { keys: JWK[] } = { keys: [] };
vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () => (header: never, token: never) =>
      actual.createLocalJWKSet(providerKeys)(header, token),
  };
});

const { beginAuthorization, consumeState, redirectUriFor, safeReturnTo, verifyIdToken } = await import('./flow');
const { hashToken } = await import('@/lib/crypto/hash');
import type { ProviderConfig } from './providers';

const config: ProviderConfig = {
  id: 'google',
  clientId: 'client-123.apps.googleusercontent.com',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://keys.test/jwks',
  scope: 'openid email profile',
  pkce: true,
};
const UA = 'Mozilla/5.0 test';

async function start() {
  const { url, binding } = await beginAuthorization({
    config,
    intent: 'login',
    returnTo: '/notes',
    userAgent: UA,
    requestOrigin: 'http://localhost:3000',
  });
  const params = new URL(url).searchParams;
  return { params, binding, state: params.get('state')!, nonce: params.get('nonce')! };
}

beforeEach(() => fake.store.clear());

describe('beginAuthorization / consumeState', () => {
  it('sends an S256 challenge whose verifier stays on the server', async () => {
    const { params, state, binding } = await start();
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('prompt')).toBe('select_account');
    // Nothing secret is in the URL or stored in the clear.
    expect([...fake.store.values()][0]).not.toHaveProperty('verifier');

    const consumed = await consumeState({ state, provider: 'google', binding, userAgent: UA });
    expect(consumed?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const challenge = createHash('sha256').update(consumed!.verifier!).digest('base64url');
    expect(params.get('code_challenge')).toBe(challenge);
    expect(consumed?.returnTo).toBe('/notes');
    expect(consumed?.redirectUri).toBe('http://localhost:3000/api/auth/oauth/google/callback');
  });

  it('honours a state exactly once', async () => {
    const { state, binding } = await start();
    expect(await consumeState({ state, provider: 'google', binding, userAgent: UA })).not.toBeNull();
    expect(await consumeState({ state, provider: 'google', binding, userAgent: UA })).toBeNull();
  });

  it('refuses a callback finished in another browser (login CSRF), and burns the state', async () => {
    const { state, binding } = await start();
    expect(await consumeState({ state, provider: 'google', binding: undefined, userAgent: UA })).toBeNull();
    expect(await consumeState({ state, provider: 'google', binding, userAgent: UA })).toBeNull();

    const second = await start();
    expect(await consumeState({ state: second.state, provider: 'google', binding: 'x'.repeat(43), userAgent: UA })).toBeNull();
  });

  it('refuses a state replayed from a different user agent', async () => {
    const b = await start();
    expect(await consumeState({ state: b.state, provider: 'google', binding: b.binding, userAgent: 'curl/8' })).toBeNull();
  });

  it('expires after ten minutes', async () => {
    vi.useFakeTimers();
    try {
      const { state, binding } = await start();
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      expect(await consumeState({ state, provider: 'google', binding, userAgent: UA })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('safeReturnTo', () => {
  it('allows same-origin paths only', () => {
    expect(safeReturnTo('/notes?x=1')).toBe('/notes?x=1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', null]) {
      expect(safeReturnTo(bad)).toBe('/dashboard');
    }
  });
});

describe('verifyIdToken', () => {
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey as CryptoKey;
    providerKeys.keys = [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }];
  });

  const nonce = 'n'.repeat(43);
  const nonceHash = hashToken(`oauth-nonce:${nonce}`);

  function token(claims: Record<string, unknown>, opts: { aud?: string } = {}) {
    return new SignJWT({ iss: 'https://accounts.google.com', sub: '42', email: 'a@gmail.com', email_verified: true, nonce, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setAudience(opts.aud ?? config.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('accepts a correctly signed token for this client with this nonce', async () => {
    await expect(verifyIdToken(config, await token({}), nonceHash)).resolves.toMatchObject({
      subject: '42',
      linkableByEmail: true,
    });
  });

  it('rejects another nonce, another audience, or a token without a nonce', async () => {
    await expect(verifyIdToken(config, await token({ nonce: 'm'.repeat(43) }), nonceHash)).rejects.toThrow();
    await expect(verifyIdToken(config, await token({}, { aud: 'someone-else' }), nonceHash)).rejects.toThrow();
    await expect(verifyIdToken(config, await token({ nonce: undefined }), nonceHash)).rejects.toThrow();
  });

  it('rejects an HMAC-signed token (algorithm confusion) and an unsigned one', async () => {
    const hs = await new SignJWT({ iss: 'https://accounts.google.com', sub: '42', nonce })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(config.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(verifyIdToken(config, hs, nonceHash)).rejects.toThrow();

    const [, payload] = (await token({})).split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${payload}.`;
    await expect(verifyIdToken(config, none, nonceHash)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const old = await new SignJWT({ iss: 'https://accounts.google.com', sub: '42', nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setAudience(config.clientId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey);
    await expect(verifyIdToken(config, old, nonceHash)).rejects.toThrow();
  });
});

describe('redirectUriFor', () => {
  it('normalises APP_URL to the exact URI registered with Google', () => {
    const previous = process.env.APP_URL;
    try {
      for (const value of ['https://www.campusnotehub.com', 'https://www.campusnotehub.com/', ' https://WWW.campusnotehub.com:443// ']) {
        process.env.APP_URL = value;
        expect(redirectUriFor('google', 'http://evil.test')).toBe(
          'https://www.campusnotehub.com/api/auth/oauth/google/callback',
        );
      }
    } finally {
      if (previous === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previous;
    }
  });
});
