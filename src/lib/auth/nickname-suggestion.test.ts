import { describe, expect, it, vi } from 'vitest';
import { nicknameBase, nicknameCandidates, suggestNickname, transliterate } from './nickname-suggestion';
import { USERNAME_PATTERN, usernameKey } from './username';

/** A deterministic stand-in for Math.random: 0.1, 0.2, 0.3, ... */
const sequence = () => {
  let n = 0;
  return () => (++n % 10) / 10;
};

describe('transliterate', () => {
  it('maps the Azerbaijani letters, including the ones NFKD cannot', () => {
    expect(transliterate('Məmməd Həmidli')).toBe('memmed hemidli');
    expect(transliterate('ışğçöüŞĞÇÖÜƏ')).toBe('isgcousgcoue');
  });

  it('lowercases the dotted capital İ to a plain i', () => {
    expect(transliterate('İlkin')).toBe('ilkin');
    expect(transliterate('ILKIN')).toBe('ilkin');
  });

  it('romanises Russian Cyrillic', () => {
    expect(transliterate('Александр Щукин')).toBe('aleksandr shchukin');
    expect(transliterate('Юлия Ёлкина')).toBe('yuliya yolkina');
    expect(transliterate('Хабибуллаев Цой Жанна')).toBe('khabibullaev tsoy zhanna');
    expect(transliterate('Подъезд Мальвина')).toBe('podezd malvina');
  });

  it('romanises Azerbaijani Cyrillic letters', () => {
    expect(transliterate('Әли Һүсејнов')).toBe('eli huseynov');
  });

  it('handles decomposed input the same as composed', () => {
    // "й" as и + combining breve: mapped as one letter, not as "i".
    expect(transliterate('Андрей')).toBe(transliterate('Андрей'));
    expect(transliterate('Андрей')).toBe('andrey');
  });

  it('strips accents from other Latin names', () => {
    expect(transliterate('José Núñez')).toBe('jose nunez');
    expect(transliterate('Straße')).toBe('strasse');
  });
});

describe('nicknameBase', () => {
  it('joins first and last name with "_"', () => {
    expect(nicknameBase('Məmməd', 'Həmidli')).toBe('memmed_hemidli');
    expect(nicknameBase('Günel', 'Qasımova')).toBe('gunel_qasimova');
    expect(nicknameBase('Ağa', 'Çələbi')).toBe('aga_celebi');
    expect(nicknameBase('Ирина', 'Мамедова')).toBe('irina_mamedova');
  });

  it('turns spaces and punctuation into single underscores', () => {
    expect(nicknameBase('Mary-Jane', "O'Neil")).toBe('mary_jane_o_neil');
    expect(nicknameBase('  Aysel  ', null)).toBe('aysel');
    expect(nicknameBase(null, 'Əliyeva')).toBe('eliyeva');
  });

  it('caps the length at 24 and never ends on "_"', () => {
    expect(nicknameBase('Aleksandra', 'Konstantinopolskaya')).toBe('aleksandra_konstantinopo');
    const cut = nicknameBase('abcdefghijklmnopqrstuvw', 'xyz'); // the cut lands on the "_"
    expect(cut).toBe('abcdefghijklmnopqrstuvw');
    expect(cut.length).toBeLessThanOrEqual(24);
  });

  it('is empty when nothing survives transliteration', () => {
    expect(nicknameBase('李', '王')).toBe('');
    expect(nicknameBase(null, null)).toBe('');
  });
});

describe('nicknameCandidates', () => {
  it('starts with the bare name, then numbered variants', () => {
    const list = nicknameCandidates('Aysel', 'Məmmədova', sequence());
    expect(list.slice(0, 3)).toEqual(['aysel_memmedova', 'aysel_memmedova2', 'aysel_memmedova3']);
  });

  it('keeps every candidate a valid, lowercase handle of at most 24', () => {
    for (const [first, last] of [
      ['Aleksandra', 'Konstantinopolskaya'],
      ['Məmməd', 'Həmidli'],
      ['Li', null],
      ['A', null],
    ] as const) {
      for (const candidate of nicknameCandidates(first, last, sequence())) {
        expect(candidate).toMatch(USERNAME_PATTERN);
        expect(candidate.length).toBeLessThanOrEqual(24);
        expect(usernameKey(candidate)).toBe(candidate);
      }
    }
  });

  it('shortens a long name to make room for the suffix', () => {
    const list = nicknameCandidates('Aleksandra', 'Konstantinopolskaya', sequence());
    expect(list[1]).toBe('aleksandra_konstantinop2');
    expect(list[1]).toHaveLength(24);
  });

  it('only offers suffixed handles for a name shorter than 3', () => {
    const list = nicknameCandidates('Li', null, sequence());
    expect(list[0]).toBe('li2');
    expect(list).not.toContain('li');
  });

  it('never suggests a reserved handle', () => {
    expect(nicknameCandidates('Admin', 'Smith')).toEqual([]);
    expect(nicknameCandidates('Support', null)).toEqual([]);
  });
});

describe('suggestNickname', () => {
  const name = { firstName: 'Məmməd', lastName: 'Həmidli' };

  it('suggests the bare name when it is free, in one lookup', async () => {
    const findTaken = vi.fn(async () => new Set<string>());
    await expect(suggestNickname(name, findTaken)).resolves.toBe('memmed_hemidli');
    expect(findTaken).toHaveBeenCalledTimes(1);
  });

  it('adds a numeric suffix when the name is taken', async () => {
    const taken = new Set(['memmed_hemidli', 'memmed_hemidli2']);
    await expect(suggestNickname(name, async () => taken)).resolves.toBe('memmed_hemidli3');
  });

  it('falls back to a random suffix once 2..9 are all taken', async () => {
    const taken = new Set(['memmed_hemidli', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `memmed_hemidli${n}`)]);
    // random() = 0.1 -> 100 + floor(0.1 * 9900) = 1090
    await expect(suggestNickname(name, async () => taken, sequence())).resolves.toBe('memmed_hemidli1090');
  });

  it('returns null when every candidate is taken', async () => {
    await expect(suggestNickname(name, async (keys) => new Set(keys))).resolves.toBeNull();
  });

  it('returns null without a lookup when the name gives nothing usable', async () => {
    const findTaken = vi.fn(async () => new Set<string>());
    await expect(suggestNickname({ firstName: '李', lastName: null }, findTaken)).resolves.toBeNull();
    expect(findTaken).not.toHaveBeenCalled();
  });
});
