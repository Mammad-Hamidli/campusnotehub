import { describe, expect, it } from 'vitest';
import labels from '@/data/majors.json';
import { MAJORS, majorSlug } from './majors';
import { FACULTY_OTHER, FACULTY_PICKER_OPTIONS, facultyLabel, isFacultySlug } from './faculties';

describe('global majors list', () => {
  it('has unique labels and slugs', () => {
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(MAJORS.map((m) => m.slug)).size).toBe(labels.length);
  });

  it('merges ADA programmes into their existing equivalents', () => {
    for (const merged of ['Computer Science', 'Economics', 'Finance', 'Laws', 'Architecture']) {
      expect(labels).not.toContain(merged);
    }
    for (const kept of ['International Studies', 'Public Affairs', 'Communication Design']) {
      expect(labels).toContain(kept);
    }
  });

  it('transliterates Azerbaijani labels to stable ASCII slugs', () => {
    expect(majorSlug('Neft-qaz mühəndisliyi')).toBe('neft-qaz-muhendisliyi');
    expect(majorSlug('İfaçılıq sənəti (Muğam)')).toBe('ifaciliq-seneti-mugam');
    expect(majorSlug('Public Affairs')).toBe('public-affairs');
  });

  it('offers every major plus "Other" last, and keeps legacy slugs valid', () => {
    expect(FACULTY_PICKER_OPTIONS.length).toBe(MAJORS.length + 1);
    expect(FACULTY_PICKER_OPTIONS.at(-1)?.slug).toBe(FACULTY_OTHER);
    expect(isFacultySlug('neft-qaz-muhendisliyi')).toBe(true);
    expect(isFacultySlug('software-engineering')).toBe(true);
    expect(facultyLabel('stomatologiya', null)).toBe('Stomatologiya');
  });
});
