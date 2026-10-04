/**
 * Notification parameters as the reader should see them.
 *
 * Rows store raw values (locale keys + params, see dispatch.ts), so an instant
 * is stored as an ISO string under `when` and rendered HERE, in the reader's
 * language and their device's time zone - a mentor in Berlin and a mentee in
 * Baku each see their own clock.
 *
 * CLIENT-ONLY on purpose: notification rows are fetched after mount, never
 * server-rendered, so this Intl call cannot cause the az hydration mismatch
 * (Node and Chromium format Azerbaijani dates differently).
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

export function formatInstant(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}
