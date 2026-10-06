/**
 * How long a mentor stays promoted in the feed's ad slot. Staff pick one of
 * these when promoting (or renewing); the slot drops the mentor when it
 * lapses - see isLiveEntry() and sweepExpiredFeedAds().
 *
 * No server imports: the admin panel renders the same list.
 */

export const FEED_AD_DURATIONS = ['1d', '1w', '1m'] as const;
export type FeedAdDuration = (typeof FEED_AD_DURATIONS)[number];

export const DEFAULT_FEED_AD_DURATION: FeedAdDuration = '1w';

const DAY_MS = 86_400_000;

/**
 * When a promotion made at `from` ends.
 *
 * A month is a calendar month at the same time of day, clamped to the end of
 * a shorter month (31 January -> 28/29 February), in UTC so the answer does
 * not depend on the server's zone. A day and a week are exact spans.
 */
export function feedAdExpiry(duration: FeedAdDuration, from: Date): Date {
  if (duration === '1d') return new Date(from.getTime() + DAY_MS);
  if (duration === '1w') return new Date(from.getTime() + 7 * DAY_MS);

  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(from.getUTCDate(), lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}
