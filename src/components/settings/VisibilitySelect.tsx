'use client';

import { Check, Globe, Lock, ShieldCheck } from 'lucide-react';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useT } from '@/lib/i18n/LocaleProvider';

export type Visibility = 'PUBLIC' | 'VERIFIED_ONLY' | 'PRIVATE';

export const VISIBILITY_OPTIONS: Visibility[] = ['PUBLIC', 'VERIFIED_ONLY', 'PRIVATE'];

const ICONS = {
  PUBLIC: Globe,
  VERIFIED_ONLY: ShieldCheck,
  PRIVATE: Lock,
} as const;

/**
 * Per-field visibility picker.
 *
 * A dropdown rather than a toggle, because there are three states and a
 * two-state switch cannot express them. The usual shortcut — one "private
 * profile" master switch — is what forces users into an all-or-nothing choice
 * they do not actually want: most students are happy to show their university
 * publicly while keeping their legal name to verified peers and their phone
 * number to nobody.
 *
 * Each option carries a plain-language hint under it. "Verified students only"
 * means nothing on its own; "only document-verified users" is a sentence
 * someone can act on.
 */
export function VisibilitySelect({
  value,
  onChange,
  labelledBy,
}: {
  value: Visibility;
  onChange: (next: Visibility) => void;
  labelledBy: string;
}) {
  const t = useT();
  const Icon = ICONS[value];

  return (
    <Menu
      label={t('settings.privacy.description')}
      width="w-64"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          data-menu-trigger
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-labelledby={`${labelledBy} ${labelledBy}-value`}
          className="btn-secondary h-8 min-w-[9.5rem] justify-between px-2.5 text-xs"
        >
          <span className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span id={`${labelledBy}-value`}>{t(`settings.privacy.options.${value}`)}</span>
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <>
          {VISIBILITY_OPTIONS.map((option) => {
            const OptionIcon = ICONS[option];
            return (
              <MenuItem
                key={option}
                selected={option === value}
                icon={<OptionIcon className="h-4 w-4" />}
                onSelect={() => {
                  onChange(option);
                  close();
                }}
                trailing={
                  option === value ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                  ) : null
                }
              >
                <span className="block">{t(`settings.privacy.options.${option}`)}</span>
                <span className="mt-0.5 block text-2xs font-normal text-fg-subtle">
                  {t(`settings.privacy.options.${option}_hint`)}
                </span>
              </MenuItem>
            );
          })}
        </>
      )}
    </Menu>
  );
}
