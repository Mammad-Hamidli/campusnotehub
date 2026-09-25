'use client';

import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronDown, Mail } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { INLINE_LINK, INLINE_MARKUP, type LocalizedSitePage, type SiteBlock } from '@/content/site/types';

/**
 * Renders an informational page (About, Help, Safety, Contact) in the
 * reader's language. A client component for the same reason as
 * LegalDocumentView: the body follows the header's language switch at once
 * instead of waiting for a reload.
 *
 * One prose column. Pages with more than three sections get a row of anchor
 * chips under the title - section ids are stable across languages, so
 * /help#notes is a link that can be shared.
 */
export function SitePageView({
  page,
  showContactCta = true,
}: {
  page: LocalizedSitePage;
  /** Off on /contact itself, where "contact us" would point at the same page. */
  showContactCta?: boolean;
}) {
  const t = useT();
  const { locale } = useLocale();
  const { eyebrow, title, summary, sections } = page[locale];

  return (
    <div className="mx-auto max-w-shell px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <article className="mx-auto min-w-0 max-w-prose">
        <header>
          <p className="text-2xs font-medium uppercase tracking-wide text-accent">{eyebrow}</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg sm:text-3xl">{title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-fg-muted">{rich(summary)}</p>
        </header>

        {sections.length > 3 && (
          <nav aria-label={t('legal.onThisPage')} className="mt-6 flex flex-wrap gap-1.5">
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="rounded-full border border-edge bg-surface px-3 py-1 text-xs text-fg-muted transition-colors duration-150 hover:border-edge-strong hover:text-fg"
              >
                {section.heading}
              </a>
            ))}
          </nav>
        )}

        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-heading`}
            // Clears the 56px sticky site header when jumped to from a chip.
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

        {showContactCta && (
          <footer className="mt-10 border-t border-edge pt-6">
            <Link
              href="/contact"
              className="card group flex items-center gap-3 p-4 transition-colors duration-150 hover:border-edge-strong"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
                <Mail className="h-4 w-4 text-accent" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{t('site.contactCta.title')}</span>
                <span className="block text-xs text-fg-muted">{t('site.contactCta.body')}</span>
              </span>
              <ArrowRight
                className="h-4 w-4 text-fg-subtle transition-transform duration-150 group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
          </footer>
        )}
      </article>
    </div>
  );
}

function Block({ block }: { block: SiteBlock }) {
  if (typeof block === 'string') {
    return <p className="mt-3 text-sm leading-relaxed text-fg-muted">{rich(block)}</p>;
  }
  if ('list' in block) {
    return (
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-fg-muted marker:text-fg-subtle">
        {block.list.map((item) => (
          <li key={item}>{rich(item)}</li>
        ))}
      </ul>
    );
  }
  // Native <details>: keyboard and screen-reader support without any script,
  // and every answer stays in the page for find-in-page and search engines.
  return (
    <div className="mt-3 divide-y divide-edge rounded-xl border border-edge bg-surface">
      {block.faq.map(({ q, a }) => (
        <details key={q} className="group px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">{q}</span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-fg-subtle transition-transform duration-150 group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">{rich(a)}</p>
        </details>
      ))}
    </div>
  );
}

/** `[label](/path)` becomes a Link and an email address a mailto: link; see INLINE_MARKUP. */
function rich(text: string): ReactNode {
  const linkClass = 'font-medium text-accent underline-offset-2 hover:underline';
  return text.split(INLINE_MARKUP).map((part, index) => {
    if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>;
    const link = INLINE_LINK.exec(part);
    return link ? (
      <Link key={index} href={link[2]} className={linkClass}>
        {link[1]}
      </Link>
    ) : (
      <a key={index} href={`mailto:${part}`} className={linkClass}>
        {part}
      </a>
    );
  });
}
