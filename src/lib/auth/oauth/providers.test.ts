import { describe, expect, it } from 'vitest';
import { OAuthError, enabledProviders, isProviderId, profileFromClaims } from './providers';

describe('the provider registry', () => {
  it('admits google and nothing else', () => {
    expect(isProviderId('google')).toBe(true);
    for (const rejected of ['', 'GOOGLE', 'google ', 'other', null, undefined, 1]) {
      expect(isProviderId(rejected)).toBe(false);
    }
  });

  /**
   * A provider with no credentials must not be offered. This is what keeps a
   * half-configured deployment from rendering a button that dead-ends.
   */
  it('offers google only when both credentials are set', () => {
    const saved = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET] as const;
    try {
      process.env.GOOGLE_CLIENT_ID = 'id';
      delete process.env.GOOGLE_CLIENT_SECRET;
      expect(enabledProviders()).toEqual([]);

      process.env.GOOGLE_CLIENT_SECRET = 'secret';
      expect(enabledProviders()).toEqual(['google']);
    } finally {
      [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET] = saved;
    }
  });
});

describe('google', () => {
  const base = { iss: 'https://accounts.google.com', sub: '1234567890', email: 'Aysel@Gmail.com', email_verified: true };

  it('trusts a verified email and allows matching by it', () => {
    expect(profileFromClaims('google', base)).toMatchObject({
      subject: '1234567890',
      email: 'aysel@gmail.com',
      emailVerified: true,
      linkableByEmail: true,
    });
  });

  it('never matches by an unverified email', () => {
    expect(profileFromClaims('google', { ...base, email_verified: false })).toMatchObject({
      emailVerified: false,
      linkableByEmail: false,
    });
    // A string is not the boolean Google sends.
    expect(profileFromClaims('google', { ...base, email_verified: 'true' }).linkableByEmail).toBe(false);
  });

  it('rejects a foreign issuer and a missing subject', () => {
    expect(() => profileFromClaims('google', { ...base, iss: 'https://evil.example' })).toThrow(OAuthError);
    expect(() => profileFromClaims('google', { ...base, sub: undefined })).toThrow(OAuthError);
  });

  it('accepts the bare accounts.google.com issuer form', () => {
    expect(profileFromClaims('google', { ...base, iss: 'accounts.google.com' }).subject).toBe('1234567890');
  });

  it('drops a malformed email rather than carrying it forward', () => {
    expect(profileFromClaims('google', { ...base, email: 'not-an-email' })).toMatchObject({
      email: null,
      emailVerified: false,
      linkableByEmail: false,
    });
  });
});
