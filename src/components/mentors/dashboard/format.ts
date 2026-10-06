import type { Locale } from '@/lib/i18n/dictionaries';
import { formatDate } from '@/lib/i18n/dates';

/**
 * Formatting for the mentor panel, which is rendered ENTIRELY on the server.
 *
 * Dates go through src/lib/i18n/dates.ts, which prints the same string on
 * Node and in every browser. Numbers still do not: Node's full ICU and
 * Chromium's trimmed one disagree on Azerbaijani decimals, so an Intl number
 * call in a hydrated client component is a hydration error for az - the
 * default locale. Keep these widgets Server Components.
 */

/** The panel's widgets are Server Components, so they take `t` as a prop. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A YYYY-MM-DD calendar date, e.g. "15 April 2026". No time zone applies. */
export function formatCalendarDate(isoDate: string, locale: Locale): string {
  return formatDate(`${isoDate}T00:00:00Z`, locale, 'dateLong', { timeZone: 'UTC' });
}

/** An instant as the mentor sees it, e.g. "Wed 15 Apr, 18:30". */
export function formatSessionTime(instant: Date, locale: Locale, timeZone: string): string {
  return formatDate(instant, locale, 'weekdayDateTime', { timeZone });
}
