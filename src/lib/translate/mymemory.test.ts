import { afterEach, describe, expect, it, vi } from 'vitest';
import { echoRatio, splitForTranslation, translateText } from './mymemory';

/** Answers MyMemory-style bodies from a langpair -> translation map and records every langpair asked for. */
function stubProvider(answers: Record<string, string>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const params = new URL(url).searchParams;
    const langpair = params.get('langpair')!;
    asked.push(`${langpair} ${params.get('q')}`);
    return new Response(
      JSON.stringify({ responseStatus: 200, responseData: { translatedText: answers[langpair] ?? params.get('q') } }),
    );
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe('translateText source language', () => {
  it('names Azerbaijani as the source instead of letting the provider guess Indonesian', async () => {
    const asked = stubProvider({ 'az|en': 'hello friend', 'autodetect|en': 'salutation dostum' });
    await expect(translateText('salam dostum', 'en')).resolves.toBe('hello friend');
    expect(asked).toEqual(['az|en salam dostum']);
  });

  it('sends ASCII-typed Azerbaijani with its proper spelling', async () => {
    const asked = stubProvider({ 'az|ru': 'как дела, брат' });
    await expect(translateText('necesen qardas', 'ru')).resolves.toBe('как дела, брат');
    expect(asked).toEqual(['az|ru necəsən qardaş']);
  });

  it('asks autodetect for a second opinion when the detected source is mostly echoed back', async () => {
    const asked = stubProvider({
      'az|en': 'derse gelirsen tomorrow?',
      'autodetect|en': 'are you coming to class tomorrow?',
    });
    await expect(translateText('sabah derse gelirsen?', 'en')).resolves.toBe('are you coming to class tomorrow?');
    expect(asked.map((line) => line.split(' ')[0])).toEqual(['az|en', 'autodetect|en']);
  });

  it('never skips the provider when the detected source equals the target', async () => {
    const asked = stubProvider({ 'autodetect|az': 'salam dostum' });
    await translateText('salam dostum', 'az').catch(() => undefined);
    expect(asked).toEqual(['autodetect|az salam dostum']);
  });
});

describe('echoRatio', () => {
  it('counts source words that came back untouched', () => {
    expect(echoRatio('salam dostum', 'salutation dostum')).toBe(0.5);
    expect(echoRatio('salam dostum', 'hello friend')).toBe(0);
  });
});

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
