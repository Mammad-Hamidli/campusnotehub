'use client';

import Link from 'next/link';
import { ArrowUpRight, BookOpen, MessagesSquare, UserRoundSearch, type LucideIcon } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type Feature = {
  key: 'notes' | 'mentor' | 'feed';
  icon: LucideIcon;
  href: string;
  /**
   * Icon chip + top wash, both from the token palette. These were
   * `bg-pink-500` / `bg-orange-500` / `bg-violet-500` - three raw Tailwind
   * ramp colours that existed nowhere else in the product, so the section that
   * introduces the three features was also the section that introduced three
   * new colours.
   */
  chip: string;
  wash: string;
  tilt: string;
};

const FEATURES: Feature[] = [
  {
    key: 'feed',
    icon: MessagesSquare,
    href: '/dashboard',
    chip: 'bg-accent text-accent-fg',
    wash: 'from-accent/10',
    tilt: 'lg:-rotate-1',
  },
  {
    key: 'notes',
    icon: BookOpen,
    href: '/notes',
    chip: 'bg-brand text-brand-fg',
    wash: 'from-brand/10',
    tilt: 'lg:rotate-1 lg:translate-y-4',
  },
  {
    key: 'mentor',
    icon: UserRoundSearch,
    href: '/mentors',
    chip: 'bg-verified text-white',
    wash: 'from-verified/10',
    tilt: 'lg:-rotate-1',
  },
];

/**
 * Feature section: three slightly tilted cards that straighten and lift on
 * hover. The social feed leads - the product is a place to hang out first and
 * a marketplace second.
 *
 * The energy is in the tilt and the hover, not in the fill: the cards sit on
 * `bg-surface` like every other card in the product, with one token-coloured
 * chip each.
 */
export function FeatureGrid() {
  const t = useT();

  return (
    <section id="features" className="border-b border-edge">
      <div className="mx-auto max-w-shell px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-xs font-bold uppercase tracking-wider text-brand">{t('landing.features.eyebrow')}</p>
          <h2 className="mt-3 text-balance text-3xl font-extrabold tracking-tight text-fg sm:text-4xl">
            {t('landing.features.title')}
          </h2>
          <p className="mt-3 text-pretty text-md leading-relaxed text-fg-muted">{t('landing.features.subtitle')}</p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <FeatureCard key={feature.key} feature={feature} t={t} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ feature, t }: { feature: Feature; t: (key: string) => string }) {
  const Icon = feature.icon;
  const base = `landing.features.${feature.key}`;

  return (
    <Link
      href={feature.href}
      className={`group relative flex flex-col overflow-hidden rounded-3xl border border-edge bg-surface p-6
                  shadow-raised transition duration-200 ease-out hover:-translate-y-1 hover:rotate-0 hover:shadow-overlay
                  ${feature.tilt}`}
    >
      <span
        className={`pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b ${feature.wash} to-transparent`}
        aria-hidden="true"
      />

      <span className={`relative flex h-11 w-11 items-center justify-center rounded-2xl ${feature.chip}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>

      <h3 className="relative mt-4 text-lg font-bold text-fg">{t(`${base}.title`)}</h3>
      <p className="relative mt-2 flex-1 text-sm leading-relaxed text-fg-muted">{t(`${base}.body`)}</p>

      <ul className="relative mt-5 space-y-2">
        {(['p1', 'p2', 'p3'] as const).map((point) => (
          <li key={point} className="flex gap-2 text-sm leading-snug text-fg">
            <span className="mt-0.5 text-xs" aria-hidden="true">
              ✦
            </span>
            <span className="min-w-0">{t(`${base}.${point}`)}</span>
          </li>
        ))}
      </ul>

      <span className="relative mt-6 inline-flex items-center gap-1 text-sm font-bold text-fg transition-colors group-hover:text-brand">
        {t(`${base}.cta`)}
        <ArrowUpRight
          className="h-4 w-4 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
    </Link>
  );
}
