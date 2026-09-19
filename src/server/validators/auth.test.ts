import { describe, expect, it } from 'vitest';
import { registerSchema } from './auth';

const base = {
  firstName: 'Aysel',
  lastName: 'Mammadova',
  dateOfBirth: '2001-05-04',
  nickname: 'aysel_m',
  email: 'aysel@example.com',
  phone: '+994501234567',
  password: 'correct horse battery',
  passwordConfirm: 'correct horse battery',
  universityId: 'BDU',
  acceptTerms: true,
};

const mentor = {
  ...base,
  accountType: 'MENTOR',
  department: 'Kapital Bank',
  academicTitle: 'Senior Engineer',
};

const student = {
  ...base,
  accountType: 'STUDENT',
  academicStatus: 'STUDYING',
  studentNumber: '2021001',
  facultySlug: 'computer-science',
  graduationYear: new Date().getFullYear() + 2,
  graduationMonth: 6,
};

const fieldErrors = (input: unknown) => {
  const parsed = registerSchema.safeParse(input);
  return parsed.success ? {} : parsed.error.flatten().fieldErrors;
};

describe('registerSchema - mentor availability', () => {
  it('requires a mentor to pick at least one slot', () => {
    expect(fieldErrors(mentor).availability).toEqual(['mentors.schedule.errors.empty']);
    expect(fieldErrors({ ...mentor, availability: [] }).availability).toEqual([
      'mentors.schedule.errors.empty',
    ]);
  });

  it('accepts a mentor schedule and normalises overlapping rules', () => {
    const parsed = registerSchema.safeParse({
      ...mentor,
      timezone: 'Asia/Baku',
      availability: [
        { weekday: 1, startMinute: 1080, endMinute: 1200 },
        { weekday: 1, startMinute: 1140, endMinute: 1260 },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.availability).toEqual([
      { weekday: 1, startMinute: 1080, endMinute: 1260 },
    ]);
  });

  it('refuses a schedule on a student registration', () => {
    const errors = fieldErrors({
      ...student,
      availability: [{ weekday: 1, startMinute: 1080, endMinute: 1200 }],
    });
    expect(errors.availability).toEqual(['errors.validationFailed']);
  });

  it('does not ask a student for a schedule', () => {
    expect(registerSchema.safeParse(student).success).toBe(true);
  });

  it('rejects an unknown timezone', () => {
    const errors = fieldErrors({
      ...mentor,
      timezone: 'Mars/Olympus',
      availability: [{ weekday: 1, startMinute: 1080, endMinute: 1200 }],
    });
    expect(errors.timezone).toBeDefined();
  });
});

describe('registerSchema - university', () => {
  const schedule = [{ weekday: 1, startMinute: 1080, endMinute: 1200 }];

  it('lets a mentor register with no university', () => {
    const parsed = registerSchema.safeParse({
      ...mentor,
      universityId: undefined,
      availability: schedule,
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses an unknown university code from a mentor', () => {
    expect(fieldErrors({ ...mentor, universityId: 'NOPE', availability: schedule }).universityId).toBeDefined();
  });

  it('requires a university from a student', () => {
    expect(fieldErrors({ ...student, universityId: undefined }).universityId).toEqual(['errors.fieldRequired']);
  });
});
