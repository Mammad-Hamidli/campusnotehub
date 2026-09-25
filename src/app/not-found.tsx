'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, SearchX } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { Logo } from '@/components/ui/Logo';

/**
 * Global 404.
 *
 * Every route the navigation links to has a real page (see the stub routes
 * under src/app), so reaching this screen means a genuinely bad URL — a typo,
 * a stale bookmark, a deleted resource. That is worth saying plainly rather
 * than dressing up: a 404 that pretends to be a feature wastes the one moment
 * the user needs a clear exit.
 */
export default function NotFound() {
  const t = useT();
  const router = useRouter();

  return (
    <main id="main" className="flex min-h-dvh flex-col">
      <header className="border-b border-edge">
        <div className="mx-auto flex h-14 max-w-shell items-center px-4 sm:px-6 lg:px-8">
          <Logo />
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md text-center">
          <div
            className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border
 border-edge bg-surface-muted"
          >
            <SearchX className="h-5 w-5 text-fg-subtle" aria-hidden="true" />
          </div>

          <p className="mt-5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">404</p>
          <h1 className="mt-1.5 text-lg font-semibold tracking-tight text-fg">
            {t('notFound.title')}
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-fg-muted">
            {t('notFound.body')}
          </p>

          <div className="mt-6 flex items-center justify-center gap-2">
            <button type="button" onClick={() => router.back()} className="btn-secondary">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('stub.back')}
            </button>
            <Link href="/" className="btn-primary">
              campusnotehub
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
