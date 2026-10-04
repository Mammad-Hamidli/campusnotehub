/**
 * A session time for an email, in the RECIPIENT's time zone, e.g.
 * "Wed, 15 Apr 2026, 18:30 GMT+4".
 *
 * Formatted once, before the email is built, because the email outbox stores
 * template parameters: a retry hours later must say exactly what the first
 * attempt said. English, like the templates themselves.
 */
export function formatEmailTime(instant: Date, timeZone: string | null | undefined): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: zone,
      timeZoneName: 'short',
    }).format(instant);
  try {
    return format(timeZone || 'Asia/Baku');
  } catch {
    // An unknown zone name on the account must not cost the email.
    return format('Asia/Baku');
  }
}
