import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/lib/i18n/dictionaries';
import { ABOUT } from './about';
import { CONTACT } from './contact';
import { HELP } from './help';
import { SAFETY } from './safety';
import { INLINE_LINK, INLINE_MARKUP, type LocalizedSitePage, type SitePage } from './types';

/**
 * The three translations of a page must describe the same page (section ids
 * are URL anchors, so /help#notes has to exist in every language), and every
 * `[label](/path)` in the copy must lead to a real route - a link that 404s in
 * one language is invisible to whoever only reads the others.
 */

/** Every string a reader can see on the page, in document order. */
function strings(page: SitePage): string[] {
  const out = [page.eyebrow, page.title, page.summary];
  for (const section of page.sections) {
    out.push(section.heading);
    for (const block of section.body) {
      if (typeof block === 'string') out.push(block);
      else if ('list' in block) out.push(...block.list);
      else for (const { q, a } of block.faq) out.push(q, a);
    }
  }
  return out;
}

function linkedPaths(page: SitePage): string[] {
  return strings(page)
    .flatMap((text) => text.split(INLINE_MARKUP).filter((_, index) => index % 2 === 1))
    .map((part) => INLINE_LINK.exec(part)?.[2])
    .filter((href): href is string => Boolean(href));
}

const APP = path.resolve(__dirname, '../../app');

describe.each([
  ['about', ABOUT],
  ['help', HELP],
  ['safety', SAFETY],
  ['contact', CONTACT],
] as [string, LocalizedSitePage][])('%s', (_name, page) => {
  const ids = (locale: (typeof LOCALES)[number]) => page[locale].sections.map((s) => s.id);

  it.each(LOCALES)('%s has the same sections, in the same order, as en', (locale) => {
    expect(ids(locale)).toEqual(ids('en'));
  });

  it('uses unique, URL-safe section ids', () => {
    const list = ids('en');
    expect(new Set(list).size).toBe(list.length);
    for (const id of list) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it.each(LOCALES)('%s has no empty text', (locale) => {
    for (const text of strings(page[locale])) expect(text.trim()).not.toBe('');
  });

  it.each(LOCALES)('%s links only to routes that exist', (locale) => {
    for (const href of linkedPaths(page[locale])) {
      const route = href.split(/[?#]/)[0];
      // A <Link> is prefetched on sight, and /logout revokes the session.
      expect(route).not.toBe('/logout');
      const file = path.join(APP, route, 'page.tsx');
      expect(existsSync(file), `${href} has no page`).toBe(true);
      // Nor to a placeholder: sending someone from Help to "under construction".
      expect(readFileSync(file, 'utf8'), `${href} is a stub`).not.toContain('<StubPage');
    }
  });

  it.each(LOCALES)('%s links to the same pages as en', (locale) => {
    expect(linkedPaths(page[locale]).sort()).toEqual(linkedPaths(page.en).sort());
  });
});
