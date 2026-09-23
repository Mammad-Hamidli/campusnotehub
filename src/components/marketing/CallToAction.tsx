'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/** Closing CTA: one gradient panel (brand -> accent) with the sign-up button. */
export function CallToAction() {
  const t = useT();

  return (
    <section id="how" className="border-b border-edge">
      <div className="mx-auto max-w-shell px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="fun-cta relative overflow-hidden rounded-3xl p-8 text-white shadow-overlay sm:p-12">
          <span
            className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/15 blur-2xl"
            aria-hidden="true"
          />
          <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-lg">
              <h2 className="text-balance text-2xl font-extrabold tracking-tight sm:text-3xl">{t('landing.cta.title')}</h2>
              <p className="mt-2 text-sm leading-relaxed text-white/90 sm:text-md">{t('landing.cta.body')}</p>
            </div>

            <div className="flex shrink-0 flex-wrap gap-2.5">
              <Link
                href="/register"
                className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-6 text-sm font-bold text-brand transition-transform duration-150 hover:-translate-y-0.5"
              >
                {t('landing.cta.button')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                href="/notes"
                className="inline-flex h-11 items-center rounded-full border border-white/60 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/10"
              >
                {t('landing.cta.secondary')}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
