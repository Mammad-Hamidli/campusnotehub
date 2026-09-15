'use client';

import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import {
  GRID_END_MINUTE,
  GRID_START_MINUTE,
  SLOT_MINUTES,
  WEEKDAYS,
  cellKey,
  minuteLabel,
} from '@/lib/mentors/schedule';

/**
 * Weekly availability matrix: 7 days x 30-minute cells, 07:00-23:00.
 *
 * Press and drag to paint; the first cell decides whether the drag selects
 * (available) or clears (blocked). Day headers toggle a whole column, hour
 * labels a whole row. Cells are buttons with aria-pressed, so Space/Enter work.
 *
 * State is a Set of "weekday:minute" keys owned by the parent; the setter is
 * functional so rapid pointerenter events never read a stale set.
 */
export function AvailabilityGrid({
  value,
  onChange,
}: {
  value: Set<string>;
  onChange: Dispatch<SetStateAction<Set<string>>>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const painting = useRef<boolean | null>(null);

  const minutes = useMemo(
    () =>
      Array.from(
        { length: (GRID_END_MINUTE - GRID_START_MINUTE) / SLOT_MINUTES },
        (_, i) => GRID_START_MINUTE + i * SLOT_MINUTES,
      ),
    [],
  );
  const dayName = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    // 2024-01-07 was a Sunday, so +weekday lands on the right day.
    return (weekday: number) => fmt.format(new Date(Date.UTC(2024, 0, 7 + weekday)));
  }, [locale]);

  useEffect(() => {
    const stop = () => (painting.current = null);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const setCells = (keys: string[], on: boolean) =>
    onChange((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const toggleGroup = (keys: string[]) => setCells(keys, !keys.every((k) => value.has(k)));

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-edge">
        <div
          className="grid min-w-[30rem] select-none"
          style={{ gridTemplateColumns: `3.25rem repeat(${WEEKDAYS.length}, minmax(0, 1fr))` }}
          role="group"
          aria-label={t('mentors.schedule.gridLabel')}
        >
          <span className="sticky left-0 bg-surface" />
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleGroup(minutes.map((m) => cellKey(d, m)))}
              className="border-b border-l border-edge bg-surface py-1.5 text-2xs font-semibold uppercase text-fg-muted hover:text-fg"
            >
              {dayName(d)}
            </button>
          ))}

          {minutes.map((m) => (
            <div key={m} className="contents">
              <button
                type="button"
                tabIndex={m % 60 === 0 ? 0 : -1}
                onClick={() => toggleGroup(WEEKDAYS.map((d) => cellKey(d, m)))}
                className="sticky left-0 bg-surface pr-1.5 text-right text-[0.625rem] tabular-nums leading-5 text-fg-subtle hover:text-fg"
              >
                {m % 60 === 0 ? minuteLabel(m) : ''}
              </button>
              {WEEKDAYS.map((d) => {
                const key = cellKey(d, m);
                const on = value.has(key);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${dayName(d)} ${minuteLabel(m)}–${minuteLabel(m + SLOT_MINUTES)}`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      // Touch captures the pointer to the first cell; release it
                      // so pointerenter fires on the cells the finger crosses.
                      (e.target as Element).releasePointerCapture?.(e.pointerId);
                      painting.current = !on;
                      setCells([key], !on);
                    }}
                    onPointerEnter={() => {
                      if (painting.current !== null) setCells([key], painting.current);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        setCells([key], !on);
                      }
                    }}
                    className={`h-5 touch-none border-l border-edge transition-colors ${
                      m % 60 === 0 ? 'border-t' : 'border-t border-t-edge/40'
                    } ${on ? 'bg-accent hover:bg-accent-hover' : 'bg-surface-muted hover:bg-surface-inset'}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-2xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-accent" /> {t('mentors.schedule.available')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border border-edge bg-surface-muted" /> {t('mentors.schedule.unavailable')}
        </span>
        <span>{t('mentors.schedule.hint')}</span>
        <button type="button" onClick={() => onChange(new Set())} className="ml-auto underline underline-offset-2 hover:text-fg">
          {t('mentors.schedule.clear')}
        </button>
      </div>
    </div>
  );
}
