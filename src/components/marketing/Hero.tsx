'use client';

import Link from 'next/link';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import type { PublicStats } from '@/lib/stats/public';
import { StatsRow } from './StatsBanner';

/**
 * Hero.
 *
 * What changed, and why each change matters:
 *
 *  - The headline is `text-display` (tops out at 3.25rem), not `text-6xl`.
 *    Oversized hero type is the loudest tell of a generated page, and it reads
 *    materially worse in Azerbaijani and Russian where the same sentence is
 *    15-30% longer and starts wrapping into four lines.
 *  - No gradient on the text. A single foreground colour with the second
 *    clause in a muted tone carries the same emphasis without the neon.
 *  - Left-aligned, not centred. Centred hero + centred subtitle + centred
 *    button pair is the template silhouette; an asymmetric layout with the
 *    stats sitting in the right column reads as a designed page.
 *  - The badge is a hairline outline, not a filled pill with a gradient.
 */
export function Hero({ stats }: { stats: PublicStats }) {
  const t = useT();

  return (
    <section className="relative overflow-hidden border-b border-edge">
      <div className="grid-field pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative mx-auto max-w-shell px-4 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-20 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-16">
          <div className="max-w-2xl">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface
 px-2.5 py-1 text-xs text-fg-muted"
            >
              <ShieldCheck className="h-3.5 w-3.5 text-verified" aria-hidden="true" />
              {t('landing.hero.badge')}
            </span>

            {/*
              The accent phrase is a separate translation key rather than a
              hardcoded span inside one string: word order differs across
              AZ / EN / RU, so a fixed split would emphasise the wrong words.
            */}
            <h1 className="mt-5 text-balance text-display font-semibold text-fg">
              {t('landing.hero.titleLead')}{' '}
              <span className="text-fg-muted">{t('landing.hero.titleAccent')}</span>
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-md leading-relaxed text-fg-muted">
              {t('landing.hero.subtitle')}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-2.5">
              <Link href="/notes" className="btn-primary h-9 px-4">
                {t('landing.hero.ctaNotes')}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
              <Link href="/mentors" className="btn-secondary h-9 px-4">
                {t('landing.hero.ctaMentor')}
              </Link>
            </div>

            <p className="mt-5 text-xs text-fg-subtle">{t('landing.hero.trust')}</p>
          </div>

          {/* Stats live beside the copy, not in a full-width dark slab below
              it. Same information, no "marketing band" break in the page. */}
          <div className="lg:pt-14">
            <StatsRow stats={stats} />
          </div>
        </div>
      </div>
    </section>
  );
}
