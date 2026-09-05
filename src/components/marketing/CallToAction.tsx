'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * Closing CTA.
 *
 * A bordered panel on the page canvas, not a dark rounded-3xl slab with two
 * radial glows. The previous version was the single most template-shaped
 * element on the page: full-bleed dark box, centred white heading, white pill
 * button. This keeps the same job and drops the costume.
 */
export function CallToAction() {
  const t = useT();

  return (
    <section id="how" className="border-b border-edge">
      <div className="mx-auto max-w-shell px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="flex flex-col gap-6 rounded-xl border border-edge bg-surface p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div className="max-w-lg">
            <h2 className="text-xl font-semibold tracking-tight text-fg">{t('landing.cta.title')}</h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t('landing.cta.body')}</p>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Link href="/register" className="btn-primary h-9 px-4">
              {t('landing.cta.button')}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <Link href="/notes" className="btn-secondary h-9 px-4">
              {t('landing.cta.secondary')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
