'use client';

import { useT } from '@/lib/i18n/LocaleProvider';

type Activity =
  | { kind: 'joined' | 'verified' | 'uploaded' | 'booked'; name: string; university: string }
  | { kind: 'popular'; title: string; count: number };

/**
 * BACKEND INTEGRATION
 * -------------------
 *   GET /api/activity/recent?limit=20   (poll 30s)  - simplest
 *   GET /api/activity/stream            (SSE)       - what we ship
 *
 * Privacy rules the API must enforce before anything reaches this component:
 *   - NICKNAME only. Never a real name - the whole point of the nickname
 *     field is that public surfaces never carry the name on someone's ID.
 *   - university code only, never faculty or student ID
 *   - `joined` and `verified` events are opt-out in notification preferences
 *   - >=60s timestamp jitter, so an observer cannot correlate "verified 3
 *     seconds ago" with a specific person they watched sign up
 *
 * Handles below are illustrative placeholders, not real users.
 */
const SEED: Activity[] = [
  { kind: 'joined', name: 'aysel_m', university: 'ADA' },
  { kind: 'uploaded', name: 'rashad_h', university: 'UNEC' },
  { kind: 'verified', name: 'nigar_q', university: 'BDU' },
  { kind: 'popular', title: 'Diskret riyaziyyat — final', count: 34 },
  { kind: 'booked', name: 'elvin_s', university: 'ADNSU' },
  { kind: 'joined', name: 'leyla_a', university: 'BMU' },
  { kind: 'uploaded', name: 'tural_i', university: 'ADA' },
  { kind: 'verified', name: 'gunel_r', university: 'ATU' },
];

/**
 * Activity ticker.
 *
 * Rebuilt as a single monochrome line of text. The previous version was a
 * dark full-bleed band of coloured pills with five different icon tints -
 * visually the loudest thing on the page, for the least important content.
 *
 * It pauses on hover, because a ticker you cannot stop to read is decoration.
 */
export function ActivityTicker() {
  const t = useT();

  const label = (item: Activity) =>
    item.kind === 'popular'
      ? t('landing.ticker.popular', { title: item.title, count: item.count })
      : t(`landing.ticker.${item.kind}`, { name: item.name });

  // Duplicated in the DOM so the -50% translate loops seamlessly. Doing it
  // here rather than in JS keeps the animation on the compositor.
  const track = [...SEED, ...SEED];

  return (
    <section className="border-b border-edge bg-surface-muted" aria-labelledby="ticker-heading">
      <h2 id="ticker-heading" className="sr-only">
        {t('landing.ticker.title')}
      </h2>

      <div className="marquee-mask group relative overflow-hidden py-2.5">
        <ul
          className="flex w-max animate-marquee items-center group-hover:[animation-play-state:paused]"
          // The visual loop is duplicated content; screen readers would
          // otherwise announce every item twice.
          aria-hidden="true"
        >
          {track.map((item, i) => (
            <li key={i} className="flex shrink-0 items-center gap-3 px-4 text-xs text-fg-muted">
              <span className="h-1 w-1 rounded-full bg-verified" aria-hidden="true" />
              <span className="whitespace-nowrap">{label(item)}</span>
              {'university' in item && (
                <span className="font-medium text-fg-subtle">{item.university}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
