'use client';

import { useEffect, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { FIELD_LABEL_KEYS, FIELD_ORDER, type AccountForm, type FieldErrors } from './types';

/**
 * Error summary shown above the form after a failed "Continue".
 *
 * This component is the actual fix for the reported navigation bug. The old
 * flow validated correctly and set the error state, but two of the fields —
 * the consent checkboxes — rendered their failure as nothing more than a
 * slightly red 16px border. So pressing Continue with a consent box unchecked
 * did *something* internally and *nothing* visible: the button read as dead,
 * and the user was stuck on step one with no idea why.
 *
 * The pattern here is the GOV.UK error-summary convention, and it exists
 * because it solves exactly this:
 *
 *  - it appears at the TOP, where the eye returns after a failed submit,
 *    rather than only next to fields that may be scrolled off screen;
 *  - it takes focus on appear, so a screen-reader user is told what went
 *    wrong instead of silently remaining on the button;
 *  - each entry is a real anchor that moves focus to the offending input.
 *
 * Ordered by FIELD_ORDER rather than object key order, so the list matches
 * the visual order of the form. An error summary in a different order than
 * the fields is worse than none.
 */
export function ErrorSummary({ errors }: { errors: FieldErrors }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  const entries = FIELD_ORDER.filter((field) => errors[field]).map((field) => ({
    field,
    labelKey: FIELD_LABEL_KEYS[field],
    messageKey: errors[field]!,
  }));

  useEffect(() => {
    if (entries.length > 0) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, JSON.stringify(errors)]);

  if (entries.length === 0) return null;

  function focusField(field: keyof AccountForm) {
    // The select and checkbox ids differ from the form key names; map them.
    const id =
      field === 'universityId'
        ? 'university'
        : field === 'graduationYear' || field === 'graduationMonth'
          ? 'gradYear'
          : field === 'acceptTerms'
            ? 'terms'
            : field === 'consentDocuments'
              ? 'consent'
              : field;

    const element = document.getElementById(id);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.focus({ preventScroll: true });
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-labelledby="error-summary-title"
      className="animate-rise mb-6 rounded-xl border border-danger/40 bg-danger-soft p-4
 focus:outline-none"
    >
      <p
        id="error-summary-title"
        className="flex items-center gap-2 text-sm font-medium text-danger-fg"
      >
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t('errors.summaryTitle', { count: entries.length })}
      </p>

      <ul className="mt-2.5 space-y-1.5">
        {entries.map(({ field, labelKey, messageKey }) => (
          <li key={field}>
            <button
              type="button"
              onClick={() => focusField(field)}
              className="text-left text-xs text-danger-fg underline decoration-danger/40
 underline-offset-2 transition-colors hover:decoration-danger-fg"
            >
              <span className="font-medium">{t(labelKey)}</span>
              <span aria-hidden="true"> — </span>
              <span>{t(messageKey)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
