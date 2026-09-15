'use client';

import { useT } from '@/lib/i18n/LocaleProvider';

export type CreatorStats = { ratingAvg: number; ratedFiles: number; reviewCount: number };

/**
 * `@username 4.6⭐ (3 files for 27 total reviews)`.
 *
 * Stats are omitted until the creator has at least one review, so a new
 * seller reads as `@username` rather than `0.0⭐ (0 files for 0 total reviews)`.
 */
export function CreatorHandle({
  nickname,
  stats,
  className = '',
}: {
  nickname: string;
  stats?: CreatorStats | null;
  className?: string;
}) {
  const t = useT();
  return (
    <span className={className}>
      @{nickname}
      {stats && stats.reviewCount > 0 && (
        <span className="ml-1 tabular-nums text-fg-subtle">
          {t('notes.creatorStats', {
            avg: stats.ratingAvg.toFixed(1),
            files: stats.ratedFiles,
            reviews: stats.reviewCount,
          })}
        </span>
      )}
    </span>
  );
}
