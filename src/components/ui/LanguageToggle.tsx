'use client';

import { Check, Languages } from 'lucide-react';
import { Menu, MenuItem, MenuLabel } from './Menu';
import { useLocale } from '@/lib/i18n/LocaleProvider';
import { LOCALES, LOCALE_META, type Locale } from '@/lib/i18n/dictionaries';

/**
 * AZ / EN / RU switcher. Default is AZ (see DEFAULT_LOCALE).
 *
 * The one rule that matters: each option is labelled in ITS OWN language.
 * Someone who landed on the Azerbaijani version because their browser said so
 * cannot find "Russian" written as "Rusca" — they are scanning for "Русский".
 * Getting this wrong strands exactly the users who most need the switcher.
 */
export function LanguageToggle() {
  const { locale, setLocale, t } = useLocale();

  return (
    <Menu
      label={t('nav.languageSwitcher')}
      width="w-48"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          data-menu-trigger
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={t('nav.languageSwitcher')}
          className="btn-ghost h-8 gap-1.5 px-2"
        >
          <Languages className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs font-medium tabular">{LOCALE_META[locale].short}</span>
        </button>
      )}
    >
      {({ close }) => (
        <>
          <MenuLabel>{t('nav.language')}</MenuLabel>
          {LOCALES.map((code: Locale) => (
            <MenuItem
              key={code}
              selected={code === locale}
              onSelect={() => {
                setLocale(code);
                close();
              }}
              trailing={
                code === locale ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                ) : null
              }
            >
              {/* lang attribute so a screen reader pronounces each option in
                  its own language rather than the page's. */}
              <span lang={code}>{LOCALE_META[code].native}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}
