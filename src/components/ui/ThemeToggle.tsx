'use client';

import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Menu, MenuItem, MenuLabel } from './Menu';
import { useTheme, type ThemePreference } from '@/lib/theme/ThemeProvider';
import { useT } from '@/lib/i18n/LocaleProvider';

const OPTIONS: { value: ThemePreference; icon: typeof Sun; labelKey: string }[] = [
  { value: 'light', icon: Sun, labelKey: 'settings.theme.light' },
  { value: 'dark', icon: Moon, labelKey: 'settings.theme.dark' },
  { value: 'system', icon: Monitor, labelKey: 'settings.theme.system' },
];

/**
 * Three-way theme selector.
 *
 * The trigger icon shows the RESOLVED theme (what you are looking at), while
 * the checkmark marks the PREFERENCE (what you chose). Those differ whenever
 * "System" is selected, and conflating them is the usual bug: a user on System
 * at night sees a moon icon and reasonably concludes they picked Dark.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { preference, resolved, setPreference } = useTheme();
  const t = useT();

  const TriggerIcon = resolved === 'dark' ? Moon : Sun;

  return (
    <Menu
      label={t('settings.theme.label')}
      width="w-44"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          data-menu-trigger
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={t('settings.theme.label')}
          className="btn-ghost h-8 w-8 p-0"
        >
          <TriggerIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    >
      {({ close }) => (
        <>
          {!compact && <MenuLabel>{t('settings.theme.label')}</MenuLabel>}
          {OPTIONS.map(({ value, icon: Icon, labelKey }) => (
            <MenuItem
              key={value}
              selected={preference === value}
              icon={<Icon className="h-4 w-4" />}
              onSelect={() => {
                setPreference(value);
                close();
              }}
              trailing={
                preference === value ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                ) : null
              }
            >
              {t(labelKey)}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}
