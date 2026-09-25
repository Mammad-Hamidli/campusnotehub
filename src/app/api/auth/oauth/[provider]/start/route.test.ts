import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

/**
 * GET /api/auth/oauth/google/start must hand the browser to Google - one 303
 * to accounts.google.com carrying state, nonce and PKCE, with the CH_OAUTH
 * binding cookie on the same response - and never bounce to another host of
 * this app except for the one deliberate canonical-host hop.
 */

process.env.VAULT_KEY = 'test-vault-key-for-oauth-start-tests-only';
const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));
vi.mock('@/lib/security/ratelimit', () => ({
  clientIp: () => '203.0.113.1',
  rateLimit: async () => ({ ok: true, retryAfterSeconds: 0 }),
}));

const { GET } = await import('./route');

const params = { params: Promise.resolve({ provider: 'google' }) };

function get(url: string, headers: Record<string, string> = {}) {
  return GET(new NextRequest(url, { headers: { 'user-agent': 'Mozilla/5.0 test', ...headers } }), params);
}

function expectGoogleHandoff(response: Response, redirectUri: string) {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location')!);
  expect(location.origin).toBe('https://accounts.google.com');
  expect(location.pathname).toBe('/o/oauth2/v2/auth');
  const q = location.searchParams;
  expect(q.get('redirect_uri')).toBe(redirectUri);
  expect(q.get('client_id')).toBe('client-123.apps.googleusercontent.com');
  expect(q.get('response_type')).toBe('code');
  expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(q.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(q.get('code_challenge_method')).toBe('S256');

  const cookie = response.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/CH_OAUTH=[A-Za-z0-9_-]{43};/);
  expect(cookie).toContain('Path=/api/auth/oauth');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toMatch(/SameSite=lax/i);
  expect(response.headers.get('cache-control')).toBe('no-store');
}

beforeEach(() => {
  fake.store.clear();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-123.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret');
  vi.stubEnv('APP_URL', 'https://www.campusnotehub.com');
  vi.stubEnv('PII_HASH_PEPPER', 'test-pepper-for-oauth-start-tests-only');
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/auth/oauth/google/start', () => {
  it('local dev with the production APP_URL: goes to Google with a localhost redirect URI, not to production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await get('http://localhost:3000/api/auth/oauth/google/start?returnTo=/notes');
    expectGoogleHandoff(response, 'http://localhost:3000/api/auth/oauth/google/callback');
  });

  it('local dev on 127.0.0.1: one hop to localhost first, because Google rejects a 127.0.0.1 redirect URI', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    // next dev reports nextUrl as localhost even here; the Host header is what the browser used.
    const response = await get('http://localhost:3000/api/auth/oauth/google/start?returnTo=/notes', {
      host: '127.0.0.1:3000',
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('http://localhost:3000/api/auth/oauth/google/start?returnTo=/notes');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('local dev on [::1]: same hop to localhost', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await get('http://[::1]:3000/api/auth/oauth/google/start', { host: '[::1]:3000' });
    expect(response.status).toBe(308);
    expect(new URL(response.headers.get('location')!).origin).toBe('http://localhost:3000');
  });

  it('production behind a TLS proxy (nextUrl reads http://): no self-redirect loop', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await get('http://www.campusnotehub.com/api/auth/oauth/google/start', {
      host: 'www.campusnotehub.com',
      'x-forwarded-proto': 'https',
    });
    expectGoogleHandoff(response, 'https://www.campusnotehub.com/api/auth/oauth/google/callback');
  });

  it('production on a non-canonical host: one 308 hop to APP_URL, keeping path and query', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await get('https://campusnotehub.com/api/auth/oauth/google/start?returnTo=/notes', {
      host: 'campusnotehub.com',
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      'https://www.campusnotehub.com/api/auth/oauth/google/start?returnTo=/notes',
    );
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('a spoofed Host in production cannot become the redirect URI', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await get('https://localhost/api/auth/oauth/google/start', { host: 'localhost' });
    expect(response.status).toBe(308);
    expect(new URL(response.headers.get('location')!).origin).toBe('https://www.campusnotehub.com');
  });
});
