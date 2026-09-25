'use client';

import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * Footer.
 *
 * On the page canvas rather than a slate-950 block. A dark footer under a
 * light page is a hard horizontal seam that makes the page feel like two
 * stitched templates - and in dark mode the old version was invisible against
 * the body anyway.
 *
 * Every link here resolves to a real 200 page. See the stub routes under
 * src/app and src/components/ui/UnderConstruction.tsx.
 */
export function SiteFooter() {
  const t = useT();

  const columns = [
    {
      heading: t('landing.footer.product'),
      links: [
        { label: t('nav.notes'), href: '/notes' },
        { label: t('nav.mentors'), href: '/mentors' },
        { label: t('nav.feed'), href: '/dashboard' },
      ],
    },
    {
      heading: t('landing.footer.company'),
      links: [
        { label: t('landing.nav.about'), href: '/about' },
        { label: t('landing.footer.contact'), href: '/contact' },
        { label: t('mentors.becomeMentor'), href: '/mentors/apply' },
        { label: t('nav.help'), href: '/help' },
      ],
    },
    {
      heading: t('landing.footer.legal'),
      links: [
        { label: t('landing.footer.terms'), href: '/legal/terms' },
        { label: t('landing.footer.privacy'), href: '/legal/privacy' },
        { label: t('landing.footer.security'), href: '/legal/security' },
      ],
    },
  ];

  return (
    <footer className="bg-canvas">
      <div className="mx-auto max-w-shell px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="max-w-xs">
            <Logo />
            <p className="mt-3 text-xs leading-relaxed text-fg-muted">
              {t('landing.footer.tagline')}
            </p>
            <div className="mt-4 flex items-center gap-1">
              <LanguageToggle />
              <ThemeToggle />
            </div>
          </div>

          {columns.map((column) => (
            <div key={column.heading}>
              <h3 className="text-xs font-medium text-fg">{column.heading}</h3>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-xs text-fg-muted transition-colors duration-150 hover:text-fg"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-2 border-t border-edge pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-fg-subtle">
            &copy; {new Date().getFullYear()} campusnotehub. {t('landing.footer.rights')}
          </p>
          <p className="text-xs text-fg-subtle">Bakı, Azərbaycan</p>
        </div>
      </div>
    </footer>
  );
}
