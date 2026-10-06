import { formatDate } from '@/lib/i18n/dates';

/**
 * Notification parameters as the reader should see them.
 *
 * Rows store raw values (locale keys + params, see dispatch.ts), so an instant
 * is stored as an ISO string under `when` and rendered HERE, in the reader's
 * language and their device's time zone - a mentor in Berlin and a mentee in
 * Baku each see their own clock.
 *
 * CLIENT-ONLY on purpose: notification rows are fetched after mount, never
 * server-rendered, and the device's time zone is the reader's.
 */
export function displayParams(
  params: Record<string, string | number>,
  locale: string,
): Record<string, string | number> {
  const when = params.when;
  if (typeof when !== 'string') return params;
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return params;
  return { ...params, when: formatInstant(date, locale) };
}

/** "Tue 6 Oct, 14:05" on the device clock - see src/lib/i18n/dates.ts for why not Intl. */
export function formatInstant(date: Date, locale: string): string {
  return formatDate(date, locale, 'weekdayDateTime');
}
