import type { Locale } from '@/lib/i18n/dictionaries';

/**
 * Formatting for the mentor panel, which is rendered ENTIRELY on the server.
 *
 * That is deliberate, not incidental: Node's full ICU and Chromium's trimmed
 * one disagree on Azerbaijani dates and numbers, so the same Intl call in a
 * hydrated client component is a hydration error for az - the default locale.
 * Formatted once here, the browser only ever receives the finished string.
 * Keep these widgets Server Components.
 */

/** The panel's widgets are Server Components, so they take `t` as a prop. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

const INTL_LOCALE: Record<Locale, string> = { az: 'az-AZ', en: 'en-GB', ru: 'ru-RU' };

/** A YYYY-MM-DD calendar date, e.g. "15 April 2026". No time zone applies. */
export function formatCalendarDate(isoDate: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** An instant as the mentor sees it, e.g. "Wed 15 Apr, 18:30". */
export function formatSessionTime(instant: Date, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(instant);
}
