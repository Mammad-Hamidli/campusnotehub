import { describe, expect, it } from 'vitest';
import { completeProfileSchema, registerSchema, splitFullName } from './auth';

const student = {
  fullName: 'Aysel Mammadova',
  nickname: 'aysel_m',
  universityId: 'BDU',
  email: 'aysel@gmail.com',
  phone: '+994 50 123 45 67',
  password: 'correct horse battery',
  acceptTerms: true,
};

const fieldErrors = (input: unknown) => {
  const parsed = registerSchema.safeParse(input);
  return parsed.success ? {} : parsed.error.flatten().fieldErrors;
};

describe('registerSchema - the six-field student sign-up', () => {
  it('accepts name, nickname, university, personal email, phone and password', () => {
    expect(registerSchema.safeParse(student).success).toBe(true);
  });

  it('accepts a personal (non-university) email', () => {
    expect(registerSchema.safeParse({ ...student, email: 'someone@outlook.com' }).success).toBe(true);
  });

  it('asks for nothing else - no date of birth, faculty or graduation date', () => {
    const parsed = registerSchema.safeParse(student);
    expect(parsed.success && Object.keys(parsed.data).sort()).toEqual(
      ['acceptTerms', 'email', 'fullName', 'locale', 'nickname', 'phone', 'password', 'universityId'].sort(),
    );
  });

  it('strips fields that no longer belong to signup instead of trusting them', () => {
    const parsed = registerSchema.safeParse({ ...student, accountType: 'MENTOR', social: true, role: 'ADMIN' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'accountType' in parsed.data).toBe(false);
    expect(parsed.success && 'role' in parsed.data).toBe(false);
  });

  it('requires every field', () => {
    for (const key of ['fullName', 'nickname', 'universityId', 'email', 'phone', 'password'] as const) {
      const rest: Record<string, unknown> = { ...student };
      delete rest[key];
      expect(fieldErrors(rest)[key]).toBeDefined();
    }
    expect(fieldErrors({ ...student, acceptTerms: false }).acceptTerms).toEqual(['auth.errors.termsRequired']);
  });

  it('refuses an unknown university code', () => {
    expect(fieldErrors({ ...student, universityId: 'NOPE' }).universityId).toBeDefined();
  });

  it('keeps the length-first password rule', () => {
    expect(fieldErrors({ ...student, password: 'short' }).password).toEqual(['auth.errors.weakPassword']);
    expect(fieldErrors({ ...student, password: 'aaaaaaaaaaaaaaaa' }).password).toEqual(['auth.errors.weakPassword']);
  });

  it('normalises the name and email', () => {
    const parsed = registerSchema.safeParse({ ...student, fullName: '  Aysel   Mammadova ', email: ' Aysel@Gmail.com ' });
    expect(parsed.success && parsed.data.fullName).toBe('Aysel Mammadova');
    expect(parsed.success && parsed.data.email).toBe('aysel@gmail.com');
  });

  it('refuses digits in a name', () => {
    expect(fieldErrors({ ...student, fullName: 'Aysel 2' }).fullName).toEqual(['auth.errors.nameInvalid']);
  });

  /**
   * Every spelling has to land on ONE value, because the E.164 string is what
   * gets hashed into the uniqueness check. If these diverged, the same number
   * could hold two accounts.
   */
  it.each([
    '+994 50 123 45 67',
    '050 123 45 67',
    '994501234567',
    '00994501234567',
    '(050) 123-45-67',
    '501234567',
  ])('normalises %s to E.164', (phone) => {
    const parsed = registerSchema.safeParse({ ...student, phone });
    expect(parsed.success && parsed.data.phone).toBe('+994501234567');
  });

  it.each([
    ['a landline', '+994 12 493 12 34'],
    ['an unknown operator code', '+994 33 123 45 67'],
    ['too few digits', '+994 50 123 45'],
    ['too many digits', '+994 50 123 45 678'],
    ['a foreign number', '+7 916 123 45 67'],
    ['letters', 'not a phone'],
  ])('refuses %s', (_label, phone) => {
    expect(fieldErrors({ ...student, phone }).phone).toEqual(['auth.errors.phoneInvalid']);
  });
});

describe('nickname rules', () => {
  it('refuses reserved handles', () => {
    expect(fieldErrors({ ...student, nickname: 'admin' }).nickname).toEqual(['auth.errors.nicknameReserved']);
  });

  it('refuses the temporary quick-login handle shape, so nobody can pose as an unfinished account', () => {
    expect(fieldErrors({ ...student, nickname: 'user34232' }).nickname).toEqual(['auth.errors.nicknameReserved']);
    expect(fieldErrors({ ...student, nickname: 'User12345' }).nickname).toEqual(['auth.errors.nicknameReserved']);
    // Not the same shape: fine.
    expect(fieldErrors({ ...student, nickname: 'user_34232' }).nickname).toBeUndefined();
  });
});

describe('completeProfileSchema', () => {
  const profile = {
    fullName: 'Aysel',
    nickname: 'aysel_m',
    universityId: 'ADA',
    password: 'correct horse battery',
    acceptTerms: true,
  };

  it('requires a strong local password (a Google-only account is lost with its Google account)', () => {
    expect(completeProfileSchema.safeParse(profile).success).toBe(true);
    expect(completeProfileSchema.safeParse({ ...profile, password: undefined }).success).toBe(false);
    expect(completeProfileSchema.safeParse({ ...profile, password: 'short' }).success).toBe(false);
  });

  it('refuses reserved staff handles', () => {
    for (const nickname of ['admin', 'admin_2', 'adm1n', 'Administrator']) {
      expect(completeProfileSchema.safeParse({ ...profile, nickname }).success, nickname).toBe(false);
    }
  });

  it('accepts an email for accounts whose provider supplied none', () => {
    expect(completeProfileSchema.safeParse({ ...profile, email: 'a@b.co' }).success).toBe(true);
    expect(completeProfileSchema.safeParse({ ...profile, email: 'not-an-email' }).success).toBe(false);
  });
});

describe('splitFullName', () => {
  it('splits the first word from the rest', () => {
    expect(splitFullName('Aysel Mammadova')).toEqual({ firstName: 'Aysel', lastName: 'Mammadova' });
    expect(splitFullName('Ali Rza Guliyev')).toEqual({ firstName: 'Ali', lastName: 'Rza Guliyev' });
  });

  it('allows a single name', () => {
    expect(splitFullName('Aysel')).toEqual({ firstName: 'Aysel', lastName: null });
  });
});
