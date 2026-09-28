'use client';

import { useLocale } from '@/lib/i18n/LocaleProvider';
import { UNIVERSITIES } from '@/lib/universities';

/**
 * The participating universities, scrolling under the stats row.
 *
 * Same list the "Universities" count comes from (src/lib/universities.ts), so
 * the number and the names cannot disagree.
 *
 * The track holds the list twice and slides left by half its own width, which
 * puts the second copy exactly where the first began: a seamless loop in CSS
 * alone. That only holds if the two copies are the same width with nothing
 * between them, so the spacing is padding inside each item rather than a gap
 * on the track. The second copy is aria-hidden so each name is announced once.
 *
 * The duration scales with the list so the speed stays readable (roughly
 * 60px a second) however many universities are added.
 *
 * Hovering pauses it. Under prefers-reduced-motion it stands still, drops the
 * duplicate and can be scrolled by hand instead.
 */
const SECONDS_PER_NAME = 4;

export function UniversityMarquee() {
  const { locale, t } = useLocale();
  const names = UNIVERSITIES.map((university) => university[locale]);

  return (
    <div>
      <p className="mb-3 text-xs font-medium text-fg-subtle">{t('landing.universities.title')}</p>
      <div className="marquee-mask group overflow-hidden motion-reduce:overflow-x-auto">
        <div
          className="flex w-max animate-marquee group-hover:[animation-play-state:paused] motion-reduce:animate-none"
          style={{ animationDuration: `${names.length * SECONDS_PER_NAME}s` }}
        >
          {[0, 1].map((copy) => (
            <ul
              key={copy}
              aria-hidden={copy === 1 || undefined}
              className={`flex shrink-0 ${copy === 1 ? 'motion-reduce:hidden' : ''}`}
            >
              {names.map((name) => (
                <li
                  key={name}
                  className="flex items-center gap-6 whitespace-nowrap pr-6 text-sm font-semibold text-fg-muted"
                >
                  {name}
                  <span className="h-1 w-1 rounded-full bg-fg-subtle" aria-hidden="true" />
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
    </div>
  );
}
