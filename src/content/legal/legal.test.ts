import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/lib/i18n/dictionaries';
import { PRIVACY } from './privacy';
import { TERMS } from './terms';

/**
 * The three translations of a legal document must describe the same document.
 *
 * Section ids are the URL anchors (/legal/privacy#cookies), so a section that
 * exists in English but not in Azerbaijani is a link that silently goes
 * nowhere for most readers - and a translation that drifted out of order is
 * one where "section 8" means different things in different languages.
 */
describe.each([
  ['terms', TERMS],
  ['privacy', PRIVACY],
])('%s', (_name, doc) => {
  const ids = (locale: (typeof LOCALES)[number]) => doc.content[locale].sections.map((s) => s.id);

  it('has a valid effective date', () => {
    expect(doc.effective).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(doc.effective).getTime())).toBe(false);
  });

  it.each(LOCALES)('%s has the same sections, in the same order, as en', (locale) => {
    expect(ids(locale)).toEqual(ids('en'));
  });

  it('uses unique, URL-safe section ids', () => {
    const list = ids('en');
    expect(new Set(list).size).toBe(list.length);
    for (const id of list) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it.each(LOCALES)('%s has no empty text', (locale) => {
    const { title, summary, sections } = doc.content[locale];
    const strings = [title, summary];
    for (const section of sections) {
      strings.push(section.heading);
      for (const block of section.body) strings.push(...(typeof block === 'string' ? [block] : block.list));
    }
    for (const text of strings) expect(text.trim()).not.toBe('');
  });
});
