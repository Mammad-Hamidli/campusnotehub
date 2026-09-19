import { describe, expect, it } from 'vitest';
import { requiredKindsFor, requirementReasonFor } from './requirements';

describe('verification requirements', () => {
  it('asks a current student for the national ID AND the student ID', () => {
    expect(requirementReasonFor('STUDENT')).toBe('STUDYING');
    expect(requiredKindsFor('STUDENT')).toEqual([
      'ID_FRONT',
      'ID_BACK',
      'STUDENT_CARD_FRONT',
      'STUDENT_CARD_BACK',
    ]);
  });

  it('asks a graduate for the national ID only', () => {
    expect(requirementReasonFor('ALUMNI')).toBe('GRADUATED');
    expect(requiredKindsFor('ALUMNI')).toEqual(['ID_FRONT', 'ID_BACK']);
  });

  it.each(['MENTOR', 'TEACHER'])('asks a %s for the national ID only', (role) => {
    expect(requirementReasonFor(role)).toBe('PROFESSIONAL');
    expect(requiredKindsFor(role)).toEqual(['ID_FRONT', 'ID_BACK']);
  });

  it('falls back to the full set for an unknown role', () => {
    expect(requiredKindsFor('SOMETHING_NEW')).toHaveLength(4);
  });
});
