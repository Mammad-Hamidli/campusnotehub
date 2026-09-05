'use client';

import Link from 'next/link';
import { ArrowLeft, Construction } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * The stub every unbuilt route renders.
 *
 * Why this exists rather than letting those links 404: a 404 tells a user the
 * page is *gone* — they conclude something is broken and stop exploring. An
 * explicit "not built yet" tells them the product is incomplete, which is both
 * true and far less alarming. It also means QA can click every link in the nav
 * and get a 200, so a genuine 404 in the logs is always a real bug rather than
 * noise from a known gap.
 *
 * Deliberately quiet: a small icon, one line, two exits. A big illustrated
 * empty state here would draw more attention to the missing feature than the
 * features that do exist.
 */
export function UnderConstruction({
  titleKey,
  /** Optional one-line description of what will land here. */
  descriptionKey,
}: {
  titleKey?: string;
  descriptionKey?: string;
}) {
  const t = useT();
  const router = useRouter();

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <div
          className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border
 border-edge bg-surface-muted"
        >
          <Construction className="h-5 w-5 text-fg-subtle" aria-hidden="true" />
        </div>

        <h1 className="mt-5 text-lg font-semibold tracking-tight text-fg">
          {t(titleKey ?? 'stub.title')}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-fg-muted">
          {t(descriptionKey ?? 'stub.body')}
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          <button type="button" onClick={() => router.back()} className="btn-secondary">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t('stub.back')}
          </button>
          <Link href="/dashboard" className="btn-primary">
            {t('stub.toFeed')}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Chrome wrapper so a stub route is still a real page with a header and a way
 * out, rather than a bare card floating on an empty canvas.
 */
export function StubPage({
  titleKey,
  descriptionKey,
}: {
  titleKey?: string;
  descriptionKey?: string;
}) {
  return (
    <main id="main" className="min-h-dvh bg-canvas">
      <UnderConstruction titleKey={titleKey} descriptionKey={descriptionKey} />
    </main>
  );
}
