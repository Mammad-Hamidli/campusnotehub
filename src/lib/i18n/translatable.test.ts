import { describe, expect, it } from 'vitest';
import {
  TARGET_META,
  TRANSLATION_TARGETS,
  normalizeTargetLang,
} from './translatable';
import { LOCALES } from './dictionaries';

/**
 * The language-code folding, which is the one piece of the translation feature
 * that fails SILENTLY when it is wrong: an unsupported code sent to the
 * provider comes back as untranslated text rather than as an error, so the
 * post looks translated and is not.
 */
describe('normalizeTargetLang', () => {
  it('accepts every canonical target', () => {
    for (const lang of TRANSLATION_TARGETS) {
      expect(normalizeTargetLang(lang)).toBe(lang);
    }
  });

  it('folds "ch" onto "zh"', () => {
    // The feature was specified with `ch` for Chinese. `ch` is Chamorro in
    // BCP-47, and sending it upstream returns the source text unchanged - so
    // the alias has to be resolved here, before the request is made.
    expect(normalizeTargetLang('ch')).toBe('zh');
    expect(normalizeTargetLang('CH')).toBe('zh');
  });

  it('ignores region and case', () => {
    expect(normalizeTargetLang('de-AT')).toBe('de');
    expect(normalizeTargetLang('EN_GB')).toBe('en');
    expect(normalizeTargetLang('zh-Hans')).toBe('zh');
    expect(normalizeTargetLang('  RU  ')).toBe('ru');
  });

  it('refuses anything unsupported, rather than guessing', () => {
    for (const value of ['', '  ', 'fr', 'tr', 'xx-YY', null, undefined, 42, {}]) {
      expect(normalizeTargetLang(value)).toBeNull();
    }
  });

  it('gives every target display metadata, and marks Arabic right-to-left', () => {
    for (const lang of TRANSLATION_TARGETS) {
      expect(TARGET_META[lang]?.native).toBeTruthy();
    }
    expect(TARGET_META.ar.dir).toBe('rtl');
    expect(TARGET_META.en.dir).toBe('ltr');
  });

  /**
   * The UI locale is used as the DEFAULT translation target on the card
   * (PostTranslation reads it from the LocaleProvider). If a UI locale ever
   * stopped folding onto a target, that default would silently become `en`
   * for those users.
   */
  it('folds every UI locale onto a translation target', () => {
    for (const locale of LOCALES) {
      expect(normalizeTargetLang(locale)).not.toBeNull();
    }
  });
});
