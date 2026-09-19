'use client';

import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { AlertCircle, CalendarClock, Plus } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { AvailabilityGrid } from '@/components/mentors/AvailabilityGrid';
import { timezones } from '@/components/mentors/MentorScheduleSettings';
import { SLOT_MINUTES, cellKey } from '@/lib/mentors/schedule';
import type { AccountForm, FieldErrors } from './types';

/**
 * One-tap starting points. Additive (a union with what is already painted),
 * so combining "weekday evenings" and "weekends" does what it says; the
 * grid's own "Clear all" is the way back to empty.
 */
const PRESETS: { id: string; labelKey: string; days: number[]; from: number; to: number }[] = [
  { id: 'evenings', labelKey: 'auth.register.schedule.presets.evenings', days: [1, 2, 3, 4, 5], from: 18 * 60, to: 21 * 60 },
  { id: 'lunch', labelKey: 'auth.register.schedule.presets.lunch', days: [1, 2, 3, 4, 5], from: 12 * 60, to: 14 * 60 },
  { id: 'weekends', labelKey: 'auth.register.schedule.presets.weekends', days: [6, 0], from: 10 * 60, to: 16 * 60 },
];

function presetCells({ days, from, to }: (typeof PRESETS)[number]): string[] {
  const keys: string[] = [];
  for (const day of days) {
    for (let m = from; m < to; m += SLOT_MINUTES) keys.push(cellKey(day, m));
  }
  return keys;
}

/**
 * Mentor-only step 4: when can students book you.
 *
 * Asked at signup because it is the one thing every mentor listing needs and
 * the one a new mentor most often never goes back to set. The value is a
 * DRAFT on the account (users.mentorAvailability): nothing is bookable until
 * the mentor application is approved, and /mentors/apply opens with this
 * grid already painted so the mentor is not asked twice.
 */
export function StepSchedule({
  value,
  errors,
  onAvailabilityChange,
  onTimezoneChange,
}: {
  value: AccountForm;
  errors: FieldErrors;
  onAvailabilityChange: Dispatch<SetStateAction<Set<string>>>;
  onTimezoneChange: (timezone: string) => void;
}) {
  const t = useT();
  const zones = useMemo(() => timezones(value.timezone), [value.timezone]);
  const hours = (value.availability.size * SLOT_MINUTES) / 60;

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="timezone" className="mb-1.5 block text-sm font-medium text-fg">
          {t('mentors.schedule.timezone')}
        </label>
        <select
          id="timezone"
          value={value.timezone}
          onChange={(e) => onTimezoneChange(e.target.value)}
          className={`input ${errors.timezone ? 'input-invalid' : ''}`}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-fg">{t('auth.register.schedule.presetsTitle')}</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() =>
                onAvailabilityChange((prev) => new Set([...prev, ...presetCells(preset)]))
              }
              className="btn-secondary h-8 text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t(preset.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/*
        tabIndex -1 so the error summary can move focus here: the grid itself
        is 224 buttons, and landing on the first one would say nothing about
        what is wrong.
      */}
      <section
        id="availability"
        tabIndex={-1}
        aria-describedby={errors.availability ? 'availability-error' : 'availability-total'}
        className="space-y-2 outline-none"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-fg">{t('mentors.schedule.weekly')}</h2>
          <p id="availability-total" aria-live="polite" className="flex items-center gap-1.5 text-xs text-fg-muted">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
            {t('auth.register.schedule.total', { hours })}
          </p>
        </div>

        <AvailabilityGrid value={value.availability} onChange={onAvailabilityChange} />

        {errors.availability && (
          <p id="availability-error" role="alert" className="flex items-start gap-1 text-xs text-danger">
            <AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(errors.availability)}</span>
          </p>
        )}
      </section>

      <p className="text-xs leading-relaxed text-fg-subtle">{t('auth.register.schedule.later')}</p>
    </div>
  );
}
