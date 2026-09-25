import { describe, expect, it } from 'vitest';
import { detectSourceLang, restoreAzSpelling } from './source';

describe('detectSourceLang', () => {
  it.each([
    ['salam dostum', 'az'],
    ['Salam dostlar, sabah görüşərik', 'az'],
    ['sabah derse gelirsen?', 'az'],
    ['sağ ol, çox yaxşı', 'az'],
    ['merhaba arkadaşım, nasılsın', 'tr'],
    ['I think the exam is tomorrow', 'en'],
    ['see you tomorrow bro', 'en'],
    ['Ich bin heute nicht da', 'de'],
    ['привет как дела', 'ru'],
    ['مرحبا يا صديقي', 'ar'],
    ['你好朋友', 'zh'],
  ])('%s -> %s', (text, lang) => {
    expect(detectSourceLang(text)).toBe(lang);
  });

  it.each(['', '123 !!!', 'ADA', 'lorem ipsum'])('says nothing without evidence: %j', (text) => {
    expect(detectSourceLang(text)).toBeNull();
  });
});

describe('restoreAzSpelling', () => {
  it('respells ASCII-typed words and keeps capitals and punctuation', () => {
    expect(restoreAzSpelling('Necesen qardas? Sabah derse gelirsen')).toBe('Necəsən qardaş? Sabah dərsə gəlirsən');
  });

  it('leaves text typed with Azerbaijani letters alone', () => {
    expect(restoreAzSpelling('mən sen')).toBe('mən sen');
  });
});
