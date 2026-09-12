'use client';

import { Check, Compass, GraduationCap, School } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import type { AccountType } from './types';

/**
 * Step 2: which kind of account is this.
 *
 * ---------------------------------------------------------------------------
 * WHY RADIO CARDS AND NOT A <select>
 * ---------------------------------------------------------------------------
 * This choice changes the rest of the form - which fields appear, which
 * documents are demanded, and what the account may eventually do on the
 * platform. A dropdown hides the alternatives behind a click and gives no room
 * to explain the consequence, so people pick wrong and discover it three steps
 * later at the document upload.
 *
 * Two large cards with a sentence each make the difference legible before the
 * commitment. They are real radio inputs underneath, so keyboard and screen
 * reader behaviour is the platform's rather than something reimplemented here.
 */
export function StepAccountType({
  value,
  error,
  onChange,
}: {
  value: AccountType | '';
  error?: string;
  onChange: (accountType: AccountType) => void;
}) {
  const t = useT();

  const options: {
    type: AccountType;
    icon: typeof GraduationCap;
    titleKey: string;
    bodyKey: string;
    pointsKey: string[];
  }[] = [
    {
      type: 'STUDENT',
      icon: GraduationCap,
      titleKey: 'auth.register.types.student.title',
      bodyKey: 'auth.register.types.student.body',
      pointsKey: [
        'auth.register.types.student.point1',
        'auth.register.types.student.point2',
      ],
    },
    {
      type: 'TEACHER',
      icon: School,
      titleKey: 'auth.register.types.teacher.title',
      bodyKey: 'auth.register.types.teacher.body',
      pointsKey: [
        'auth.register.types.teacher.point1',
        'auth.register.types.teacher.point2',
      ],
    },
    /**
     * Mentor is a first-class signup choice, not a later upgrade.
     *
     * Someone who arrives to mentor has no reason to hold a student account,
     * and requiring one is what previously dead-ended them at /login. Picking
     * this grants no privilege by itself - the account still verifies its
     * identity and still needs a moderator to approve its profile before it
     * appears in the directory.
     */
    {
      type: 'MENTOR',
      icon: Compass,
      titleKey: 'auth.register.types.mentor.title',
      bodyKey: 'auth.register.types.mentor.body',
      pointsKey: [
        'auth.register.types.mentor.point1',
        'auth.register.types.mentor.point2',
      ],
    },
  ];

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium text-fg">
        {t('auth.register.accountType')}
        <span className="ml-1 text-danger" aria-hidden="true">
          *
        </span>
      </legend>
      <p className="mb-3 text-sm text-fg-muted">{t('auth.register.accountTypeHint')}</p>

      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((option) => {
          const selected = value === option.type;
          const Icon = option.icon;
          return (
            <label
              key={option.type}
              className={`relative flex cursor-pointer flex-col rounded-xl border p-4 transition-colors ${
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-edge bg-surface hover:border-edge-strong hover:bg-surface-muted'
              }`}
            >
              {/* A real radio, visually hidden. The card is the label, so a
                  click anywhere on it selects - and the browser still handles
                  arrow-key navigation between the two. */}
              <input
                type="radio"
                name="accountType"
                value={option.type}
                checked={selected}
                onChange={() => onChange(option.type)}
                className="sr-only"
                required
              />

              <span className="flex items-center gap-2.5">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    selected ? 'bg-accent text-accent-fg' : 'bg-surface-inset text-fg-muted'
                  }`}
                  aria-hidden="true"
                >
                  <Icon className="h-4.5 w-4.5" />
                </span>
                <span className="text-sm font-semibold text-fg">{t(option.titleKey)}</span>
                {selected && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                )}
              </span>

              <span className="mt-2.5 text-xs leading-relaxed text-fg-muted">
                {t(option.bodyKey)}
              </span>

              {/* States the concrete consequence - which documents this branch
                  will ask for - so the choice is made with that known rather
                  than discovered at the upload step. */}
              <ul className="mt-2.5 space-y-1">
                {option.pointsKey.map((key) => (
                  <li key={key} className="flex items-start gap-1.5 text-2xs text-fg-subtle">
                    <span aria-hidden="true">·</span>
                    <span>{t(key)}</span>
                  </li>
                ))}
              </ul>
            </label>
          );
        })}
      </div>

      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
