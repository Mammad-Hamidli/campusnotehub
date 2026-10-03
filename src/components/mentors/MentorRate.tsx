'use client';

import { useLocale } from '@/lib/i18n/LocaleProvider';
import { formatRate } from '@/lib/mentors/display';

/**
 * A mentor's hourly rate, as an informational label and nothing more.
 *
 * The rate is cosmetic: the platform has no payments, so nothing charges it,
 * holds it or deducts it - POST /api/mentors/:id/bookings never reads
 * hourlyRateMinor and booking is free whatever the profile says. Every surface
 * renders the rate through this component so the "display only" qualifier
 * cannot quietly go missing from one of them.
 *
 * Render only once the mentor data has been fetched on the client, like
 * formatRate() itself (az currency hydration mismatch).
 */
export function MentorRate({ minor, className }: { minor: number; className?: string }) {
  const { t, locale } = useLocale();
  const price = formatRate(minor, locale);

  if (!price) return <span className={className}>{t('mentors.free')}</span>;

  return (
    <span className={className}>
      {t('mentors.rate', { price })}
      <span className="font-normal text-fg-subtle"> · {t('mentors.rateDisplayOnly')}</span>
    </span>
  );
}
