import { describe, expect, it } from 'vitest';
import { splitForTranslation } from './mymemory';

const rejoin = (text: string, max?: number) =>
  splitForTranslation(text, max)
    .map((p) => p.lead + p.text + p.trail)
    .join('');

describe('splitForTranslation', () => {
  it('keeps a short post in one piece', () => {
    expect(splitForTranslation('Salam dostlar!')).toEqual([{ lead: '', text: 'Salam dostlar!', trail: '' }]);
  });

  it.each([
    'One. Two! Three?\n\nFour...ok',
    '...leading punctuation and trailing space   ',
    `${'word '.repeat(200)}end.`,
    `${'x'.repeat(1200)}`,
  ])('reproduces the input exactly and respects the cap: %#', (text) => {
    expect(rejoin(text, 100)).toBe(text);
    for (const piece of splitForTranslation(text, 100)) expect(piece.text.length).toBeLessThanOrEqual(100);
  });
});
