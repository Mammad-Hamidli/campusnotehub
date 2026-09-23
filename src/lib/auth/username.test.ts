import { describe, expect, it } from 'vitest';
import { parseLoginIdentifier, usernameKey } from './username';
import { loginSchema } from '@/server/validators/auth';

describe('usernameKey', () => {
  it('lowercases and accepts one leading @', () => {
    expect(usernameKey('Aysel_01')).toBe('aysel_01');
    expect(usernameKey('  @Aysel_01 ')).toBe('aysel_01');
  });

  it('is locale-independent for the Azerbaijani capital I', () => {
    // toLocaleLowerCase('az') would give dotless "ı" and a different key.
    expect(usernameKey('ILKIN')).toBe('ilkin');
  });

  it('rejects anything outside the ASCII pattern', () => {
    for (const bad of ['ab', 'a'.repeat(25), '@@aysel', 'ays el', 'aysəl', 'аysel' /* Cyrillic а */, 'a-b', '']) {
      expect(usernameKey(bad)).toBeNull();
    }
  });
});

describe('parseLoginIdentifier', () => {
  it('classifies emails and lowercases them', () => {
    expect(parseLoginIdentifier(' Aysel@ADA.edu.az ')).toEqual({ kind: 'email', value: 'aysel@ada.edu.az' });
  });

  it('treats a leading @ as a handle, never as an email', () => {
    expect(parseLoginIdentifier('@aysel')).toEqual({ kind: 'username', value: 'aysel' });
    expect(parseLoginIdentifier('@aysel@ada.edu.az')).toBeNull();
  });

  it('classifies bare handles', () => {
    expect(parseLoginIdentifier('Aysel')).toEqual({ kind: 'username', value: 'aysel' });
  });

  it('rejects malformed and oversized input', () => {
    for (const bad of ['', '   ', 'aysel@', 'aysel@ada', 'a b@c.d', 'x'.repeat(255)]) {
      expect(parseLoginIdentifier(bad)).toBeNull();
    }
  });
});

describe('loginSchema', () => {
  const password = 'correct horse battery';

  it('accepts an identifier of either kind', () => {
    expect(loginSchema.parse({ identifier: 'aysel', password }).identifier).toEqual({
      kind: 'username',
      value: 'aysel',
    });
    expect(loginSchema.parse({ identifier: 'A@ada.edu.az', password }).identifier).toEqual({
      kind: 'email',
      value: 'a@ada.edu.az',
    });
  });

  it('keeps the legacy email field working, for emails only', () => {
    expect(loginSchema.parse({ email: 'a@ada.edu.az', password }).identifier.kind).toBe('email');
    expect(loginSchema.safeParse({ email: 'aysel', password }).success).toBe(false);
  });

  it('refuses a body naming two identifiers', () => {
    expect(loginSchema.safeParse({ identifier: 'aysel', email: 'a@ada.edu.az', password }).success).toBe(false);
  });

  it('refuses a missing identifier or password', () => {
    expect(loginSchema.safeParse({ password }).success).toBe(false);
    expect(loginSchema.safeParse({ identifier: 'aysel', password: '' }).success).toBe(false);
  });
});
