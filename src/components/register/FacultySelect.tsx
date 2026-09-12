'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { FACULTIES, FACULTY_GROUPS, FACULTY_OTHER, type FacultyOption } from '@/lib/faculties';

/**
 * Faculty picker: a searchable combobox over the 60+ entry catalogue.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A NATIVE <select>
 * ---------------------------------------------------------------------------
 * The rest of the registration form uses native selects, and for university
 * (18 options) or graduation month (12) that is the right call - it is
 * accessible for free and gets the platform's own mobile picker.
 *
 * At sixty-plus options it stops working. A native select has no search, so
 * finding "Telecommunications Engineering" means scrolling a list the height
 * of the screen; on a phone it becomes a full-screen wheel with no way to jump.
 * Type-ahead exists but only matches from the first character, so someone
 * looking for "Software Engineering" who types "eng" lands nowhere.
 *
 * So this is a combobox: type to filter, arrow keys to move, Enter to choose.
 * It follows the WAI-ARIA combobox pattern rather than inventing one, which is
 * what keeps it operable by keyboard and announced correctly by a screen
 * reader - `role="combobox"`, `aria-expanded`, `aria-activedescendant` on the
 * input, and `role="option"` with `aria-selected` on the rows.
 *
 * The options stay grouped, because a flat alphabetical list of sixty fields
 * is genuinely harder to scan than eight labelled sections.
 */
export function FacultySelect({
  value,
  otherValue,
  onChange,
  onOtherChange,
  error,
  otherError,
}: {
  value: string;
  otherValue: string;
  onChange: (slug: string) => void;
  onOtherChange: (text: string) => void;
  error?: string;
  otherError?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  /**
   * Suppresses the reopen that a programmatic refocus would otherwise cause.
   *
   * choose() closes the list and then returns focus to the input for keyboard
   * users - but the input's onFocus opens the list, so the two fought and the
   * dropdown never actually closed. Sixty-six options stayed on screen
   * covering the rest of the form after every selection.
   *
   * A ref rather than state: it must be readable inside the very next focus
   * event, before React would have re-rendered.
   */
  const suppressOpenRef = useRef(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selected = useMemo(() => FACULTIES.find((f) => f.slug === value) ?? null, [value]);

  /**
   * Filtering is accent- and case-insensitive.
   *
   * `localeCompare`-style normalisation matters here: an Azerbaijani keyboard
   * produces "İ" and "ı", and a Russian-locale user may type Cyrillic. NFD +
   * stripping combining marks means "Muhendislik" finds "Mühendislik"-style
   * entries, so a near-miss still lands on the right row instead of an empty
   * list that reads as "your field is not here".
   */
  const normalize = (input: string) =>
    input
      .toLocaleLowerCase('en')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

  const matches = useMemo(() => {
    const needle = normalize(query.trim());
    if (!needle) return FACULTIES;
    return FACULTIES.filter(
      (f) => normalize(f.label).includes(needle) || normalize(f.group).includes(needle),
    );
  }, [query]);

  /** Flat list drives keyboard navigation; the render below regroups it. */
  const grouped = useMemo(() => {
    return FACULTY_GROUPS.map((group) => ({
      group,
      options: matches.filter((f) => f.group === group),
    })).filter((section) => section.options.length > 0);
  }, [matches]);

  // A filter change can leave the highlight past the end of the new list.
  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Keeps the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function choose(option: FacultyOption) {
    onChange(option.slug);
    setOpen(false);
    setQuery('');
    // Clearing the free-text field when the choice is no longer "Other" keeps
    // the pair coherent, which is what both the zod refinement and the CHECK
    // constraint require. Leaving a stale value here would be a 500 at submit.
    if (option.slug !== FACULTY_OTHER) onOtherChange('');

    // Refocus for keyboard users without letting onFocus reopen the list.
    suppressOpenRef.current = true;
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (!open) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = matches[activeIndex];
      if (option) choose(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  // Running counter so grouped rendering and flat keyboard indices agree.
  let flatIndex = -1;

  return (
    <div className="space-y-2">
      <div ref={rootRef} className="relative">
        <label
          htmlFor="facultySlug"
          className="mb-1.5 block text-sm font-medium text-fg"
        >
          {t('auth.register.faculty')}
        </label>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <input
            id="facultySlug"
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
            aria-invalid={Boolean(error)}
            autoComplete="off"
            // Shows the CHOSEN label when closed and the QUERY while typing.
            // A combobox that clears itself on focus makes the user re-find a
            // selection they had already made just to look at the list.
            value={open ? query : (selected?.label ?? '')}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => {
              // A focus caused by choose() must not reopen the list; a focus
              // the user initiated should.
              if (suppressOpenRef.current) {
                suppressOpenRef.current = false;
                return;
              }
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            placeholder={t('auth.register.facultyPlaceholder')}
            className={`input py-2 pl-9 pr-9 text-sm ${error ? 'input-invalid' : ''}`}
          />
          <ChevronDown
            className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle transition-transform ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          />
        </div>

        {open && (
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={t('auth.register.faculty')}
            className="overlay absolute z-50 mt-1 max-h-72 w-full overflow-y-auto p-1"
          >
            {grouped.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">
                {t('auth.register.facultyNoMatch')}
              </p>
            ) : (
              grouped.map((section) => (
                <div key={section.group}>
                  <div className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                    {section.group}
                  </div>
                  {section.options.map((option) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isActive = index === activeIndex;
                    const isSelected = option.slug === value;
                    return (
                      <button
                        key={option.slug}
                        id={`${listboxId}-${index}`}
                        data-index={index}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        // Mouse-over syncs the highlight with the pointer so
                        // the keyboard and mouse do not fight over which row
                        // is "current".
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(option)}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                          isActive ? 'bg-surface-muted text-fg' : 'text-fg-muted'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {isSelected && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}

        {error && (
          <p className="mt-1.5 text-xs text-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* The free-text field appears only for "Other", and is required then -
          both the zod schema and a CHECK constraint enforce that pairing, so
          this is the UX half of a rule the database also holds. */}
      {value === FACULTY_OTHER && (
        <div className="animate-fade-in">
          <label htmlFor="facultyOther" className="mb-1.5 block text-sm font-medium text-fg">
            {t('auth.register.facultyOther')}
          </label>
          <input
            id="facultyOther"
            type="text"
            required
            aria-required="true"
            aria-invalid={Boolean(otherError)}
            value={otherValue}
            onChange={(e) => onOtherChange(e.target.value)}
            maxLength={120}
            placeholder={t('auth.register.facultyOtherPlaceholder')}
            className={`input py-2 text-sm ${otherError ? 'input-invalid' : ''}`}
          />
          {otherError && (
            <p className="mt-1.5 text-xs text-danger" role="alert">
              {otherError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
