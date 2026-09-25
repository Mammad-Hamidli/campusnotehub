'use client';

import { useCallback, useState } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { Menu, MenuItem } from '@/components/ui/Menu';
import {
  TARGET_META,
  TRANSLATION_TARGETS,
  normalizeTargetLang,
  type TargetLang,
} from '@/lib/i18n/translatable';
import { TranslationError, translateText } from '@/lib/translate/mymemory';

/**
 * "Translate this post", on the card.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSLATION IS SHOWN BESIDE THE ORIGINAL, NOT INSTEAD OF IT
 * ---------------------------------------------------------------------------
 * The original stays on screen and the translation appears under it, marked as
 * machine-made. Replacing the body would be tidier and is the wrong call
 * twice: a reader who speaks some of the source language needs to compare when
 * the translation reads oddly, and a translation that silently replaces the
 * author's words attributes machine output to a person. The attribution line
 * is not decoration.
 *
 * ---------------------------------------------------------------------------
 * ONE REQUEST PER LANGUAGE, PER CARD
 * ---------------------------------------------------------------------------
 * Results are kept in a per-card map, so switching back to a language already
 * fetched is instant; src/lib/translate/mymemory.ts also caches per tab. Both
 * matter, because MyMemory's free quota is counted per reader.
 *
 * The component renders NOTHING until pressed beyond its own button, so a feed
 * page of twenty cards issues zero translation requests on load. Machine
 * translation is opt-in per post by design.
 *
 * The text is translated in the browser, straight from MyMemory - there is no
 * server route. Only a body the reader can already see is ever sent. There is
 * no `readOnly` prop, unlike the like button: translating is READING, which a
 * view-only quick-login account may do.
 */
export function PostTranslation({ text }: { text: string }) {
  const t = useT();
  const { locale } = useLocale();

  /** Language -> translated text. The per-card cache described above. */
  const [results, setResults] = useState<Partial<Record<TargetLang, string>>>({});
  const [active, setActive] = useState<TargetLang | null>(null);
  const [pending, setPending] = useState<TargetLang | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The language offered first is the one the reader has the interface in -
   * `az`, `en` or `ru` today. normalizeTargetLang folds it onto a target
   * rather than assuming the two lists agree, because they deliberately do
   * not: the UI has three languages and this menu has six.
   */
  const preferred = normalizeTargetLang(locale) ?? 'en';

  const translate = useCallback(
    async (lang: TargetLang) => {
      setError(null);
      setActive(lang);

      // Already fetched on this card: show it without a round trip.
      if (results[lang]) return;

      setPending(lang);
      try {
        const translated = await translateText(text, lang);
        setResults((prev) => ({ ...prev, [lang]: translated }));
      } catch (cause) {
        // Always a locale KEY, so the failure reads in the reader's language.
        setError(cause instanceof TranslationError ? cause.messageKey : 'feed.translate.errors.failed');
        setActive(null);
      } finally {
        setPending(null);
      }
    },
    [text, results],
  );

  const shown = active ? results[active] : undefined;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1">
        {/* One tap translates into the reader's own language; the caret opens
            the other five. Two controls rather than a menu for everything,
            because the overwhelmingly common case is "my language". */}
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => {
            if (active) {
              setActive(null);
            } else {
              void translate(preferred);
            }
          }}
          aria-expanded={Boolean(active)}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium
                     text-fg-muted transition hover:bg-surface-inset hover:text-fg
                     disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {active ? t('feed.translate.showOriginal') : t('feed.translate.action')}
        </button>

        <Menu
          label={t('feed.translate.chooseLanguage')}
          width="w-48"
          trigger={({ open: menuOpen, toggle, id }) => (
            <button
              type="button"
              data-menu-trigger
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={id}
              aria-label={t('feed.translate.chooseLanguage')}
              onClick={toggle}
              disabled={pending !== null}
              className="rounded-lg px-1.5 py-1 text-2xs font-semibold text-fg-subtle transition
                         hover:bg-surface-inset hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {active ? TARGET_META[active].short : '···'}
            </button>
          )}
        >
          {({ close }) => (
            <>
              {TRANSLATION_TARGETS.map((lang) => (
                <MenuItem
                  key={lang}
                  selected={active === lang}
                  icon={<span aria-hidden="true">{TARGET_META[lang].flag}</span>}
                  onSelect={() => {
                    close();
                    void translate(lang);
                  }}
                >
                  {TARGET_META[lang].native}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
      </div>

      {error && (
        <p
          role="status"
          className={`mt-1.5 text-xs ${error === 'feed.translate.errors.sameLanguage' ? 'text-fg-muted' : 'text-danger'}`}
        >
          {t(error)}
        </p>
      )}

      {active && shown && (
        <div className="mt-2 rounded-xl border border-edge bg-surface-inset p-3">
          {/*
            dir and lang are both set from the target language, not inherited.
            Arabic in an otherwise left-to-right card renders with its
            punctuation at the wrong end without dir="rtl", and a screen reader
            pronounces the whole paragraph in the page's language without
            `lang` - which makes an Arabic translation unusable to exactly the
            reader who asked for it.
          */}
          <p
            lang={active}
            dir={TARGET_META[active].dir}
            className="whitespace-pre-wrap break-words text-[0.9375rem] leading-relaxed text-fg"
          >
            {shown}
          </p>
          <p className="mt-2 text-2xs text-fg-subtle">
            {t('feed.translate.attribution', { language: TARGET_META[active].native })}
          </p>
        </div>
      )}
    </div>
  );
}
