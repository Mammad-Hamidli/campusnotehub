'use client';

import Link from 'next/link';
import { ArrowUpRight, BookOpen, MessagesSquare, UserRoundSearch, type LucideIcon } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type Feature = { key: 'notes' | 'mentor' | 'feed'; icon: LucideIcon; href: string };

const FEATURES: Feature[] = [
  { key: 'notes', icon: BookOpen, href: '/notes' },
  { key: 'mentor', icon: UserRoundSearch, href: '/mentors' },
  { key: 'feed', icon: MessagesSquare, href: '/dashboard' },
];

/**
 * Feature section.
 *
 * Rebuilt as a bordered 3-column table rather than three floating cards with
 * coloured icon tiles and lift-on-hover shadows. The old version had a
 * different accent colour per card (indigo / violet / emerald), which is the
 * multi-colour tell the brief calls out — and it also broke the rule that
 * emerald means "verified" and nothing else.
 *
 * Hover is a border and text colour change only. No transform, no shadow.
 */
export function FeatureGrid() {
  const t = useT();

  return (
    <section id="features" className="border-b border-edge">
      <div className="mx-auto max-w-shell px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            {t('landing.features.eyebrow')}
          </p>
          <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
            {t('landing.features.title')}
          </h2>
          <p className="mt-3 text-pretty text-md leading-relaxed text-fg-muted">
            {t('landing.features.subtitle')}
          </p>
        </div>

        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-edge bg-edge sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <FeatureCell key={feature.key} feature={feature} t={t} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCell({ feature, t }: { feature: Feature; t: (key: string) => string }) {
  const Icon = feature.icon;
  const base = `landing.features.${feature.key}`;

  return (
    <Link
      href={feature.href}
      className="group flex flex-col bg-surface p-6 transition-colors duration-150 hover:bg-surface-muted"
    >
      <Icon className="h-5 w-5 text-fg-subtle transition-colors duration-150 group-hover:text-accent" aria-hidden="true" />

      <h3 className="mt-4 text-md font-medium text-fg">{t(`${base}.title`)}</h3>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-fg-muted">{t(`${base}.body`)}</p>

      <ul className="mt-5 space-y-1.5 border-t border-edge pt-4">
        {(['p1', 'p2', 'p3'] as const).map((point) => (
          <li key={point} className="flex gap-2 text-xs leading-snug text-fg-muted">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-fg-subtle" aria-hidden="true" />
            <span className="min-w-0">{t(`${base}.${point}`)}</span>
          </li>
        ))}
      </ul>

      <span className="mt-5 inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition-colors group-hover:text-accent">
        {t(`${base}.title`)}
        <ArrowUpRight
          className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          aria-hidden="true"
        />
      </span>
    </Link>
  );
}
