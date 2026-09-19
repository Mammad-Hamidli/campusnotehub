'use client';

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, ArrowUp, FileText, ShieldCheck } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import type { LegalBlock, LocalizedLegalDocument } from '@/content/legal/types';

export type LegalSlug = 'terms' | 'privacy';

const RELATED: Record<LegalSlug, { href: string; labelKey: string; icon: typeof FileText }> = {
  terms: { href: '/legal/terms', labelKey: 'landing.footer.terms', icon: FileText },
  privacy: { href: '/legal/privacy', labelKey: 'landing.footer.privacy', icon: ShieldCheck },
};

/**
 * Renders a legal document (Terms, Privacy) in the reader's language.
 *
 * A client component so the body follows the header's language switch
 * instantly, like every other page - a server-rendered body would stay in the
 * old language until a reload while the chrome around it changed. All three
 * translations therefore ship with the page; that cost is paid by these two
 * routes only, not by every page as it would be from messages/*.json.
 *
 * Layout: a sticky table of contents beside a prose-width column on desktop,
 * collapsed into a <details> above the text on phones. Section ids are stable
 * across languages, so /legal/privacy#cookies is a link that can be shared.
 */
export function LegalDocumentView({
  document: doc,
  slug,
}: {
  document: LocalizedLegalDocument;
  slug: LegalSlug;
}) {
  const t = useT();
  const { locale } = useLocale();
  const { title, summary, sections } = doc.content[locale];
  const active = useActiveSection(sections.map((section) => section.id));

  const effective = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(doc.effective),
  );
  const related = RELATED[slug === 'terms' ? 'privacy' : 'terms'];
  const RelatedIcon = related.icon;

  const toc = (
    <ol className="space-y-0.5">
      {sections.map((section) => (
        <li key={section.id}>
          <a
            href={`#${section.id}`}
            aria-current={active === section.id ? 'location' : undefined}
            className={`block rounded-md px-2 py-1 text-xs leading-snug transition-colors duration-150 ${
              active === section.id
                ? 'bg-surface-muted font-medium text-fg'
                : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
            }`}
          >
            {section.heading}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="mx-auto max-w-shell px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:block">
          <nav aria-label={t('legal.onThisPage')} className="sticky top-20">
            <p className="mb-2 px-2 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
              {t('legal.onThisPage')}
            </p>
            {toc}
          </nav>
        </aside>

        <article className="min-w-0 max-w-prose">
          <header>
            <p className="text-2xs font-medium uppercase tracking-wide text-accent">
              {t('landing.footer.legal')}
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg sm:text-3xl">{title}</h1>
            <p className="mt-3 text-sm leading-relaxed text-fg-muted">{summary}</p>
            <p className="mt-3 text-xs text-fg-subtle">
              {/* ICU data can differ slightly between Node and the browser. */}
              <time dateTime={doc.effective} suppressHydrationWarning>
                {t('legal.effective', { date: effective })}
              </time>
            </p>
          </header>

          <p
            role="note"
            className="mt-6 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn-fg"
          >
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t('legal.draftNotice')}</span>
          </p>

          <details className="card mt-6 p-3 lg:hidden">
            <summary className="cursor-pointer px-2 text-sm font-medium text-fg">{t('legal.onThisPage')}</summary>
            <nav aria-label={t('legal.onThisPage')} className="mt-2">
              {toc}
            </nav>
          </details>

          {sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-heading`}
              // Clears the 56px sticky site header when jumped to from the TOC.
              className="mt-8 scroll-mt-20 border-t border-edge pt-6"
            >
              <h2 id={`${section.id}-heading`} className="text-base font-semibold tracking-tight text-fg">
                {section.heading}
              </h2>
              {section.body.map((block, index) => (
                <Block key={index} block={block} />
              ))}
            </section>
          ))}

          <footer className="mt-10 border-t border-edge pt-6">
            <p className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">{t('legal.related')}</p>
            <Link
              href={related.href}
              className="card group mt-3 flex items-center gap-3 p-4 transition-colors duration-150 hover:border-edge-strong"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
                <RelatedIcon className="h-4 w-4 text-accent" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 text-sm font-medium text-fg">{t(related.labelKey)}</span>
              <ArrowRight
                className="h-4 w-4 text-fg-subtle transition-transform duration-150 group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
            <a
              href="#main"
              className="mt-6 inline-flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              {t('legal.backToTop')}
            </a>
          </footer>
        </article>
      </div>
    </div>
  );
}

function Block({ block }: { block: LegalBlock }) {
  if (typeof block === 'string') {
    return <p className="mt-3 text-sm leading-relaxed text-fg-muted">{linkify(block)}</p>;
  }
  return (
    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-fg-muted marker:text-fg-subtle">
      {block.list.map((item) => (
        <li key={item}>{linkify(item)}</li>
      ))}
    </ul>
  );
}

/** Turns email addresses in the copy into mailto links, so the text stays plain data. */
function linkify(text: string): ReactNode {
  const parts = text.split(/([\w.+-]+@[\w-]+\.[\w.]+[\w])/);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <a key={index} href={`mailto:${part}`} className="font-medium text-accent underline-offset-2 hover:underline">
        {part}
      </a>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/**
 * The section currently being read, for highlighting in the table of contents.
 * "Current" is the last section whose heading has scrolled past the upper
 * third of the viewport.
 */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join('|');

  useEffect(() => {
    const elements = key
      .split('|')
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const update = () => {
      const line = window.innerHeight / 3;
      let current: string | null = null;
      for (const element of elements) {
        if (element.getBoundingClientRect().top <= line) current = element.id;
      }
      setActive(current);
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [key]);

  return active;
}
