'use client';

import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import type { PublicStats } from '@/lib/stats/public';
import type { WindowsInstaller } from '@/lib/desktop/windowsInstaller';
import { StatsRow } from './StatsBanner';
import { WindowsDownloadButton } from './WindowsDownload';

/**
 * The social features, each in its own floating bubble.
 *
 * A real <ul>: the bubbles ARE the bullet list, so screen readers get the
 * points as a list and nothing about them is decoration-only. Position, tilt
 * and float delay are per item so the cluster reads as a lively pile of chat
 * bubbles rather than a grid. Below lg they fall back to a wrapping row
 * (still floating) - absolute positioning on a phone would overlap the
 * headline.
 *
 * The tones cycle through THREE, not six. Six bubbles in six colours made the
 * cluster read as a colour chart, and the emoji already give each one its own
 * identity - so the liveliness comes from the float, the tilt and the glyph,
 * and the colour just keeps them from looking like a plain list. Adjacent
 * bubbles never share a tone.
 */
const BUBBLES = [
  { key: 'follow', emoji: '👋', tone: 'fun-bubble-brand', pos: 'lg:left-[4%] lg:top-[4%]', tilt: '-4deg', delay: '0s' },
  { key: 'feed', emoji: '🔥', tone: 'fun-bubble-accent', pos: 'lg:right-[2%] lg:top-[16%]', tilt: '3deg', delay: '-1.5s' },
  { key: 'comment', emoji: '💬', tone: 'fun-bubble-verified', pos: 'lg:left-[10%] lg:top-[34%]', tilt: '2deg', delay: '-3s' },
  { key: 'notes', emoji: '📚', tone: 'fun-bubble-brand', pos: 'lg:right-[6%] lg:top-[48%]', tilt: '-3deg', delay: '-4.5s' },
  { key: 'mentor', emoji: '🤝', tone: 'fun-bubble-accent', pos: 'lg:left-[2%] lg:top-[64%]', tilt: '-2deg', delay: '-2.2s' },
  { key: 'campus', emoji: '🎓', tone: 'fun-bubble-verified', pos: 'lg:right-[10%] lg:top-[80%]', tilt: '4deg', delay: '-3.7s' },
] as const;

export function Hero({ stats, installer }: { stats: PublicStats; installer: WindowsInstaller | null }) {
  const t = useT();

  return (
    <section className="relative overflow-hidden border-b border-edge">
      <div className="fun-mesh pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative mx-auto max-w-shell px-4 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:px-8">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-12">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-surface/80 px-3 py-1 text-xs font-semibold text-brand backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {t('landing.hero.badge')}
            </span>

            <h1 className="mt-5 text-balance text-[clamp(2.25rem,5vw,3.75rem)] font-extrabold leading-[1.05] tracking-tight text-fg">
              {t('landing.hero.titleLead')}{' '}
              <span className="fun-gradient-text">{t('landing.hero.titleAccent')}</span>
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-fg-muted">
              {t('landing.hero.subtitle')}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/register"
                className="fun-cta inline-flex h-11 items-center gap-2 rounded-full px-6 text-sm font-bold text-white shadow-overlay transition-transform duration-150 hover:-translate-y-0.5"
              >
                {t('landing.hero.ctaJoin')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link href="/notes" className="btn-secondary h-11 rounded-full px-5">
                {t('landing.hero.ctaNotes')}
              </Link>
            </div>

            {/* empty:hidden - the button renders nothing inside the desktop app. */}
            <div className="mt-4 empty:hidden">
              <WindowsDownloadButton installer={installer} />
            </div>

            <p className="mt-5 text-xs text-fg-subtle">{t('landing.hero.trust')}</p>
          </div>

          <div className="relative">
            <h2 className="sr-only">{t('landing.social.title')}</h2>
            <ul className="flex flex-wrap gap-2.5 lg:relative lg:block lg:h-[26rem]">
              {BUBBLES.map((b) => (
                <li
                  key={b.key}
                  className={`fun-bubble ${b.tone} ${b.pos} flex items-center gap-2 lg:absolute`}
                  style={{ ['--tilt' as string]: b.tilt, animationDelay: b.delay }}
                >
                  <span className="text-lg leading-none" aria-hidden="true">
                    {b.emoji}
                  </span>
                  {t(`landing.social.items.${b.key}`)}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 lg:mt-14">
          <StatsRow stats={stats} />
        </div>
      </div>
    </section>
  );
}
