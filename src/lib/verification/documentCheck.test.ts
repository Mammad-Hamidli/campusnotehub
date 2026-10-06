import { describe, expect, it } from 'vitest';
import {
  compare,
  institutionMatches,
  namesMatch,
  parseExtraction,
  tokenMatches,
  nameTokens,
  type Extraction,
  type ProfileFacts,
} from './documentCheck';

const NOW = new Date('2026-10-06T21:00:00Z');

const idCard = (overrides: Partial<Extraction> = {}): Extraction => ({
  documentType: 'NATIONAL_ID',
  givenName: 'AYSEL',
  surname: 'MƏMMƏDOVA',
  patronymic: 'RAMİL QIZI',
  dateOfBirth: '2005-03-14',
  expiryDate: '2031-03-14',
  institution: null,
  legible: true,
  fullyVisible: true,
  screenPhoto: false,
  signsOfEditing: false,
  ...overrides,
});

const studentCard = (overrides: Partial<Extraction> = {}): Extraction =>
  idCard({
    documentType: 'STUDENT_CARD',
    givenName: 'Aysel',
    surname: 'Məmmədova',
    patronymic: null,
    dateOfBirth: null,
    expiryDate: null,
    institution: 'ADA University',
    ...overrides,
  });

const student: ProfileFacts = {
  fullName: 'Aysel Mammadova',
  firstName: null,
  lastName: null,
  dateOfBirth: null,
  university: { code: 'ADA', names: ['ADA University', 'ADA Universiteti', 'Университет ADA'] },
};

const mentor: ProfileFacts = { ...student, university: null };

describe('parseExtraction', () => {
  it('reads a bare JSON answer', () => {
    expect(parseExtraction(JSON.stringify(idCard()))).toEqual(idCard());
  });

  it('tolerates code fences and a sentence around the object', () => {
    const raw = 'Here is the data:\n```json\n' + JSON.stringify(idCard()) + '\n```';
    expect(parseExtraction(raw)?.surname).toBe('MƏMMƏDOVA');
  });

  it('returns null for prose and broken JSON', () => {
    expect(parseExtraction('I cannot read this document.')).toBeNull();
    expect(parseExtraction('{"givenName": "Aysel",')).toBeNull();
  });

  it('reads a missing integrity flag as the unsafe value', () => {
    const parsed = parseExtraction('{"documentType":"NATIONAL_ID","givenName":"A","surname":"B"}');
    expect(parsed).toMatchObject({ legible: false, fullyVisible: false, screenPhoto: true, signsOfEditing: true });
  });

  it('drops malformed dates and unknown document types instead of failing', () => {
    const parsed = parseExtraction(
      JSON.stringify({ ...idCard(), documentType: 'DRIVING_LICENCE', expiryDate: '14.03.2031' }),
    );
    expect(parsed).toMatchObject({ documentType: 'OTHER', expiryDate: null });
  });
});

describe('names', () => {
  it('folds Azerbaijani capitals the way the ID card prints them', () => {
    expect(nameTokens('HƏMİDLİ')).toEqual(['həmidli']);
    expect(nameTokens('ŞÜKÜROV')).toEqual(['sukurov']);
    expect(nameTokens('Məmməd oğlu')).toEqual(['məmməd']);
  });

  it('lets a printed ə match a typed ə, e or a - and nothing else', () => {
    expect(tokenMatches('mammad', 'məmməd')).toBe(true);
    expect(tokenMatches('memmed', 'məmməd')).toBe(true);
    expect(tokenMatches('məmməd', 'məmməd')).toBe(true);
    expect(tokenMatches('mamed', 'məmməd')).toBe(false);
    expect(tokenMatches('mommad', 'məmməd')).toBe(false);
  });

  it('matches the typed name to the document in either order', () => {
    expect(namesMatch({ fullName: 'Mammad Hamidli' }, { givenName: 'MƏMMƏD', surname: 'HƏMİDLİ', patronymic: null })).toBe(true);
    expect(namesMatch({ fullName: 'Hamidli Mammad' }, { givenName: 'MƏMMƏD', surname: 'HƏMİDLİ', patronymic: null })).toBe(true);
  });

  it('accepts a typed patronymic but not a word that is not on the document', () => {
    const doc = { givenName: 'AYSEL', surname: 'MƏMMƏDOVA', patronymic: 'RAMİL QIZI' };
    expect(namesMatch({ fullName: 'Aysel Ramil qızı Məmmədova' }, doc)).toBe(true);
    expect(namesMatch({ fullName: 'Aysel Leyla Məmmədova' }, doc)).toBe(false);
  });

  it('requires both the given name and the surname from the document', () => {
    const doc = { givenName: 'AYSEL', surname: 'MƏMMƏDOVA', patronymic: null };
    expect(namesMatch({ fullName: 'Aysel' }, doc)).toBe(false);
    expect(namesMatch({ fullName: 'Aysel Məmmədova' }, { ...doc, surname: null })).toBe(false);
  });

  it('holds the split profile name to the matching halves', () => {
    const doc = { givenName: 'AYSEL', surname: 'MƏMMƏDOVA', patronymic: null };
    expect(namesMatch({ fullName: 'Aysel Məmmədova', firstName: 'Aysel', lastName: 'Məmmədova' }, doc)).toBe(true);
    expect(namesMatch({ fullName: 'Aysel Məmmədova', firstName: 'Məmmədova', lastName: 'Aysel' }, doc)).toBe(false);
  });

  it('never matches a name the folding cannot read (Cyrillic)', () => {
    expect(namesMatch({ fullName: 'Aysel Məmmədova' }, { givenName: 'Айсель', surname: 'Мамедова', patronymic: null })).toBe(false);
  });
});

describe('institutionMatches', () => {
  const ada = { code: 'ADA', names: ['ADA University'] };
  const bsu = { code: 'BDU', names: ['Baku State University', 'Bakı Dövlət Universiteti'] };

  it('matches the short code as a word, or the full name', () => {
    expect(institutionMatches('ADA University', ada)).toBe(true);
    expect(institutionMatches('ADA', ada)).toBe(true);
    expect(institutionMatches('BAKI DÖVLƏT UNİVERSİTETİ', bsu)).toBe(true);
    expect(institutionMatches('Baku State University, Faculty of Law', bsu)).toBe(true);
  });

  it('does not match a shared single word or another university', () => {
    expect(institutionMatches('Baku', bsu)).toBe(false);
    expect(institutionMatches('Baku Engineering University', bsu)).toBe(false);
    expect(institutionMatches('Khazar University', ada)).toBe(false);
    expect(institutionMatches('Canada College', ada)).toBe(false);
  });
});

describe('compare', () => {
  it('approves a student whose ID and student card both match completely', () => {
    const result = compare(
      [
        { kind: 'ID_FRONT', extraction: idCard() },
        { kind: 'STUDENT_CARD_FRONT', extraction: studentCard() },
      ],
      student,
      NOW,
    );
    expect(result).toMatchObject({ outcome: 'APPROVE', codes: [], confidence: 1 });
    expect(result.scores).toMatchObject({ name_match: 1, university_match: 1, not_expired: 1, documents_checked: 2 });
  });

  it('approves an identity-only account on the ID alone', () => {
    expect(compare([{ kind: 'ID_FRONT', extraction: idCard() }], mentor, NOW).outcome).toBe('APPROVE');
  });

  it.each([
    ['a name mismatch', { givenName: 'LEYLA' }, 'NAME_MISMATCH'],
    ['an unreadable name', { surname: null }, 'NAME_UNREADABLE'],
    ['an expired card', { expiryDate: '2026-10-05' }, 'CARD_EXPIRED'],
    ['an ID with no readable expiry', { expiryDate: null }, 'EXPIRY_UNREADABLE'],
    ['a photo of a screen', { screenPhoto: true }, 'SCREEN_RECAPTURE'],
    ['signs of editing', { signsOfEditing: true }, 'DIGITAL_TAMPERING'],
    ['an illegible image', { legible: false }, 'BLURRY'],
    ['cut-off edges', { fullyVisible: false }, 'CROPPED_EDGES'],
    ['the wrong document', { documentType: 'STUDENT_CARD' as const }, 'WRONG_DOCUMENT_TYPE'],
  ])('flags %s', (_label, overrides, code) => {
    const result = compare([{ kind: 'ID_FRONT', extraction: idCard(overrides) }], mentor, NOW);
    expect(result.outcome).toBe('FLAG');
    expect(result.codes).toContain(code);
  });

  it('flags an answer that did not parse', () => {
    const result = compare([{ kind: 'ID_FRONT', extraction: null }], mentor, NOW);
    expect(result).toMatchObject({ outcome: 'FLAG', codes: ['AI_RESPONSE_INVALID'] });
  });

  it('flags a student whose card names another university, or is missing', () => {
    const wrongUni = compare(
      [
        { kind: 'ID_FRONT', extraction: idCard() },
        { kind: 'STUDENT_CARD_FRONT', extraction: studentCard({ institution: 'Khazar University' }) },
      ],
      student,
      NOW,
    );
    expect(wrongUni.codes).toEqual(['UNIVERSITY_MISMATCH']);

    const noCard = compare([{ kind: 'ID_FRONT', extraction: idCard() }], student, NOW);
    expect(noCard.codes).toContain('STUDENT_CARD_MISSING');
  });

  it('checks the date of birth only when the profile holds one', () => {
    const withDob = { ...mentor, dateOfBirth: new Date('2005-03-14T00:00:00Z') };
    expect(compare([{ kind: 'ID_FRONT', extraction: idCard() }], withDob, NOW).outcome).toBe('APPROVE');
    expect(
      compare([{ kind: 'ID_FRONT', extraction: idCard({ dateOfBirth: '2004-03-14' }) }], withDob, NOW).codes,
    ).toEqual(['DOB_MISMATCH']);
  });

  it('flags a name that differs on the student card even when the ID matches', () => {
    const result = compare(
      [
        { kind: 'ID_FRONT', extraction: idCard() },
        { kind: 'STUDENT_CARD_FRONT', extraction: studentCard({ givenName: 'Leyla' }) },
      ],
      student,
      NOW,
    );
    expect(result.codes).toEqual(['NAME_MISMATCH']);
    expect(result.scores.name_match).toBe(0);
  });

  it('never returns extracted text, only codes and numbers', () => {
    const result = compare([{ kind: 'ID_FRONT', extraction: idCard({ givenName: 'LEYLA' }) }], mentor, NOW);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toMatch(/LEYLA|AYSEL|MƏMMƏDOVA|2005-03-14/i);
    for (const value of Object.values(result.scores)) expect(typeof value).toBe('number');
  });
});
