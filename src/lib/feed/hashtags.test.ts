import { describe, expect, it } from 'vitest';
import { completedHashtags, extractHashtags, splitHashtags } from './hashtags';

describe('hashtags', () => {
  it('finds tags in any script, once each', () => {
    expect(extractHashtags('#İmtahan sabah! #exam #Экзамен #EXAM')).toEqual(['İmtahan', 'exam', 'Экзамен']);
  });

  it('ignores mid-word hashes, single letters and C#', () => {
    expect(extractHashtags('mail#tag C# #a ok')).toEqual([]);
  });

  it('treats the tag at the end as still being typed', () => {
    expect(completedHashtags('#Exam')).toEqual([]);
    expect(completedHashtags('#Exam ')).toEqual(['Exam']);
    expect(completedHashtags('#Exam, #Deadline')).toEqual(['Exam']);
  });

  it('splits text around tags without losing characters', () => {
    const text = 'Sabah #imtahan var.';
    const parts = splitHashtags(text);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(parts.find((p) => p.tag)?.tag).toBe('imtahan');
  });
});
