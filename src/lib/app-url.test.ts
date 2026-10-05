import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flowOrigin, sameHostOrigin } from './app-url';

const APP = 'https://www.campusnotehub.com';

beforeEach(() => vi.stubEnv('APP_URL', APP));
afterEach(() => vi.unstubAllEnvs());

describe('flowOrigin (OAuth) vs sameHostOrigin (cookie-carrying redirects)', () => {
  it('in development, OAuth runs on localhost for every loopback host; other redirects stay put', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(flowOrigin(origin)).toBe('http://localhost:3000');
      expect(sameHostOrigin(origin)).toBe(origin);
    }
  });

  it('a non-loopback or unparseable origin gets APP_URL', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const origin of ['http://evil.test', 'http://127.0.0.2:3000', 'not a url']) {
      expect(flowOrigin(origin)).toBe(APP);
      expect(sameHostOrigin(origin)).toBe(APP);
    }
  });

  it('in production, loopback is not special', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(flowOrigin('http://127.0.0.1:3000')).toBe(APP);
    expect(sameHostOrigin('http://localhost:3000')).toBe(APP);
  });
});
