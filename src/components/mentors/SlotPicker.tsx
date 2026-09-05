'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale } from '@/lib/i18n/LocaleProvider';

type ApiSlot = { startsAt: string; endsAt: string; available: boolean };
type Bucket = 'morning' | 'afternoon' | 'evening';

const BUCKET_LABEL: Record<Bucket, Record<string, string>> = {
  morning: { az: 'Səhər', en: 'Morning', ru: 'Утро' },
  afternoon: { az: 'Günorta', en: 'Afternoon', ru: 'День' },
  evening: { az: 'Axşam', en: 'Evening', ru: 'Вечер' },
};

/**
 * Calendly-style availability picker.
 *
 * Two decisions carry most of the usability here:
 *
 *  1. Times render in the VIEWER's timezone, with the zone named on screen.
 *     Mentors are frequently alumni working abroad, so "14:00" with no zone is
 *     a booking someone will miss. The label is always visible, not a tooltip.
 *  2. Unavailable slots are rendered struck through, not hidden. A day showing
 *     three of twelve slots reads as "barely available"; three slots with nine
 *     crossed out reads as "popular, book now" — and it tells the user the
 *     mentor works that day at all, so they try next week instead of giving up.
 */
export function SlotPicker({
  mentorId,
  sessionMinutes,
  priceMinor,
  onSelect,
}: {
  mentorId: string;
  sessionMinutes: number;
  priceMinor: number;
  onSelect: (startsAt: string) => void;
}) {
  const { locale, t } = useLocale();
  const viewerTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [slots, setSlots] = useState<ApiSlot[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const intlLocale = { az: 'az-AZ', en: 'en-GB', ru: 'ru-RU' }[locale];

  const fmtTime = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { hour: '2-digit', minute: '2-digit', hour12: false }),
    [intlLocale],
  );
  const fmtWeekday = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { weekday: 'short' }),
    [intlLocale],
  );
  const fmtLongDate = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'long' }),
    [intlLocale],
  );
  const fmtMoney = useMemo(
    () => new Intl.NumberFormat(intlLocale, { style: 'currency', currency: 'AZN' }),
    [intlLocale],
  );

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() + weekOffset * 7 + i);
        return d;
      }),
    [weekOffset],
  );

  useEffect(() => {
    let cancelled = false;
    setSlots(null);

    const date = toDateKey(selectedDate);
    /* BACKEND INTEGRATION
     *   GET /api/mentors/:id/bookings?date=YYYY-MM-DD&tz=<IANA zone>
     *   -> { date, timezone, slots: [{ startsAt, endsAt, available }] }
     *
     * Slot generation lives in src/lib/mentors/availability.ts: weekly rules
     * stored as minutes-from-local-midnight in the MENTOR's timezone, converted
     * to absolute UTC instants, then rendered in the viewer's zone here.
     */
    fetch(`/api/mentors/${mentorId}/bookings?date=${date}&tz=${encodeURIComponent(viewerTz)}`)
      .then((r) => r.json())
      .then((data) => !cancelled && setSlots(data.slots ?? []))
      .catch(() => !cancelled && setSlots([]));

    return () => {
      cancelled = true;
    };
  }, [mentorId, selectedDate, viewerTz]);

  const grouped = useMemo(() => {
    const out: Record<Bucket, ApiSlot[]> = { morning: [], afternoon: [], evening: [] };
    for (const slot of slots ?? []) {
      const hour = new Date(slot.startsAt).getHours();
      out[hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'].push(slot);
    }
    return out;
  }, [slots]);

  return (
    <div className="card p-4">
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setWeekOffset((v) => Math.max(0, v - 1))}
          disabled={weekOffset === 0}
          aria-label="Previous week"
          className="rounded-lg p-2 text-fg-muted transition hover:bg-surface-inset disabled:opacity-30"
        >
          <ChevronLeft className="h-[1.15rem] w-[1.15rem]" />
        </button>

        <div className="flex flex-1 gap-1.5 overflow-x-auto pb-1">
          {days.map((day) => {
            const active = toDateKey(day) === toDateKey(selectedDate);
            return (
              <button
                key={day.toISOString()}
                type="button"
                onClick={() => {
                  setSelectedDate(day);
                  setSelected(null);
                }}
                aria-pressed={active}
                className={`flex min-w-[3.25rem] shrink-0 flex-col items-center rounded-lg px-2 py-2
                            text-sm transition ${
                              active
                                ? 'bg-accent font-semibold text-accent-fg'
                                : 'bg-surface-muted text-fg hover:bg-surface-inset'
                            }`}
              >
                <span className="text-[0.7rem] uppercase opacity-75">{fmtWeekday.format(day)}</span>
                <span className="tabular text-base font-semibold">{day.getDate()}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setWeekOffset((v) => v + 1)}
          aria-label="Next week"
          className="rounded-lg p-2 text-fg-muted transition hover:bg-surface-inset"
        >
          <ChevronRight className="h-[1.15rem] w-[1.15rem]" />
        </button>
      </div>

      <p className="mb-3 text-xs text-fg-muted">
        {t('mentors.booking.timezoneNote', { timezone: viewerTz })}
      </p>

      {slots === null && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-surface-inset" />
          ))}
        </div>
      )}

      {slots?.length === 0 && (
        <p className="py-8 text-center text-sm text-fg-muted">{t('mentors.booking.noSlots')}</p>
      )}

      {slots && slots.length > 0 && (
        <div className="space-y-4">
          {(['morning', 'afternoon', 'evening'] as const).map((bucket) =>
            grouped[bucket].length === 0 ? null : (
              <fieldset key={bucket}>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                  {BUCKET_LABEL[bucket][locale]}
                </legend>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {grouped[bucket].map((slot) => {
                    const isSelected = selected === slot.startsAt;
                    return (
                      <button
                        key={slot.startsAt}
                        type="button"
                        disabled={!slot.available}
                        onClick={() => {
                          setSelected(slot.startsAt);
                          onSelect(slot.startsAt);
                        }}
                        aria-pressed={isSelected}
                        className={`tabular min-h-[2.75rem] rounded-lg border px-2 py-2 text-sm
                                    font-medium transition ${
                                      isSelected
                                        ? 'border-accent bg-accent text-accent-fg'
                                        : slot.available
                                          ? 'border-edge bg-surface text-fg hover:border-accent hover:bg-accent-soft'
                                          : 'cursor-not-allowed border-transparent bg-surface-muted text-fg-subtle line-through'
                                    }`}
                      >
                        {fmtTime.format(new Date(slot.startsAt))}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ),
          )}
        </div>
      )}

      {selected && (
        <div className="mt-4 animate-rise rounded-lg bg-surface-muted p-3 text-sm">
          <p className="font-medium text-fg">
            {t('mentors.booking.summary', {
              date: fmtLongDate.format(new Date(selected)),
              time: fmtTime.format(new Date(selected)),
              duration: sessionMinutes,
            })}
          </p>
          <p className="mt-1 text-fg-muted">
            {t('mentors.booking.total', { price: fmtMoney.format(priceMinor / 100) })}
          </p>
          <p className="mt-1 text-xs text-fg-muted">{t('mentors.booking.escrowNote')}</p>
        </div>
      )}
    </div>
  );
}

/** Local-time YYYY-MM-DD. toISOString() would shift the date across midnight. */
function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
