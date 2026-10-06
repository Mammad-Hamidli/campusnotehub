import { describe, expect, it } from 'vitest';
import { formatDate, weekdayName, type DateFormat } from './dates';

/**
 * Node ships full ICU, so it is the reference the tables were copied from:
 * every format must print exactly what Node's Intl prints for the same
 * options. A browser without az data cannot be the reference - that is the
 * bug this module exists for.
 */
const INTL: Record<string, string> = { az: 'az-AZ', en: 'en-GB', ru: 'ru-RU' };
const ICU_OPTIONS: Partial<Record<DateFormat, Intl.DateTimeFormatOptions>> = {
  dayMonth: { day: 'numeric', month: 'short' },
  dayMonthLong: { day: 'numeric', month: 'long' },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  dateLong: { day: 'numeric', month: 'long', year: 'numeric' },
  monthYear: { month: 'long', year: 'numeric' },
  dateTime: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  dayMonthTime: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  weekdayDateTime: { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

// Every month, every weekday, and both ends of the clock.
const SAMPLES = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, i % 12, 1 + ((i * 5) % 28), (i * 7) % 24, (i * 13) % 60)));

describe('formatDate', () => {
  for (const lang of ['az', 'en', 'ru']) {
    for (const [format, options] of Object.entries(ICU_OPTIONS)) {
      it(`${lang} ${format} matches full ICU`, () => {
        const icu = new Intl.DateTimeFormat(INTL[lang], { ...options, timeZone: 'UTC' });
        for (const sample of SAMPLES) {
          expect(formatDate(sample, lang, format as DateFormat, { timeZone: 'UTC' })).toBe(icu.format(sample));
        }
      });
    }
  }

  it('never prints the CLDR root month names ("M10") that Chromium falls back to for az', () => {
    for (const sample of SAMPLES) {
      for (const format of Object.keys(ICU_OPTIONS) as DateFormat[]) {
        expect(formatDate(sample, 'az', format, { timeZone: 'UTC' })).not.toMatch(/\bM\d{2}\b/);
      }
    }
    expect(formatDate('2026-10-06T14:05:00Z', 'az', 'dayMonth', { timeZone: 'UTC' })).toBe('6 okt');
    expect(formatDate('2026-10-06T14:05:00Z', 'az', 'monthYear', { timeZone: 'UTC' })).toBe('oktyabr 2026');
  });

  it('reads the wall clock of the requested zone, across a date line', () => {
    const instant = new Date('2026-10-06T22:30:00Z');
    expect(formatDate(instant, 'en', 'dateTime', { timeZone: 'UTC' })).toBe('6 Oct 2026, 22:30');
    expect(formatDate(instant, 'en', 'dateTime', { timeZone: 'Asia/Baku' })).toBe('7 Oct 2026, 02:30');
    expect(formatDate(instant, 'en', 'weekdayDateTime', { timeZone: 'Asia/Baku' })).toBe('Wed 7 Oct, 02:30');
    expect(formatDate('2026-10-06T20:00:00Z', 'en', 'time', { timeZone: 'Asia/Baku' })).toBe('00:00');
  });

  it('accepts BCP 47 tags, falls back to English, and renders bad input as empty', () => {
    const instant = '2026-03-02T09:00:00Z';
    expect(formatDate(instant, 'ru-RU', 'dateLong', { timeZone: 'UTC' })).toBe('2 марта 2026 г.');
    expect(formatDate(instant, 'de', 'dayMonth', { timeZone: 'UTC' })).toBe('2 Mar');
    expect(formatDate('not a date', 'az', 'date')).toBe('');
    // An unknown zone uses the device clock rather than throwing.
    expect(formatDate(instant, 'en', 'date', { timeZone: 'Mars/Olympus' })).toMatch(/^\d{1,2} Mar 2026$/);
  });
});

describe('weekdayName', () => {
  it('matches the standalone CLDR heading, 0 = Sunday', () => {
    for (const lang of ['az', 'en', 'ru']) {
      const icu = new Intl.DateTimeFormat(INTL[lang], { weekday: 'short', timeZone: 'UTC' });
      for (let weekday = 0; weekday < 7; weekday++) {
        // 4 Jan 2026 was a Sunday.
        expect(weekdayName(weekday, lang)).toBe(icu.format(new Date(Date.UTC(2026, 0, 4 + weekday))));
      }
    }
  });
});
