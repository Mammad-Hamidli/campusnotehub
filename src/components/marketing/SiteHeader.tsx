'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu as MenuIcon, X } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useT } from '@/lib/i18n/LocaleProvider';
import { WindowsDownloadLink } from './WindowsDownload';

/**
 * Marketing header.
 *
 * Deliberately plain: a 56px bar, a hairline bottom border that only appears
 * once you scroll, and text links at 13px. The previous version had a 64px bar
 * with a filled pill CTA and a blurred glass background from the first pixel —
 * which is the exact silhouette of every generated SaaS landing page.
 *
 * The border-on-scroll is the one piece of motion, and it exists for a real
 * reason: without it the nav floats ambiguously over the hero content.
 */
export function SiteHeader() {
  const t = useT();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  const links = [
    { href: '#features', label: t('landing.nav.features') },
    { href: '#how', label: t('landing.nav.how') },
    { href: '/about', label: t('landing.nav.about') },
  ];

  return (
    <header
      className={`sticky top-0 z-40 bg-canvas/80 backdrop-blur-md transition-colors duration-200 ${
        scrolled ? 'border-b border-edge' : 'border-b border-transparent'
      }`}
    >
      {/* gap-3 below sm: at 360px the logo, two toggles and the hamburger are
          already 300px of content, and a 24px gap pushed the menu button off
          the right edge. */}
      <div className="mx-auto flex h-14 w-full max-w-shell items-center justify-between gap-3 px-4 sm:gap-6 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-7">
          <Logo />
          <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-fg-muted transition-colors duration-150 hover:text-fg"
              >
                {link.label}
              </Link>
            ))}
            {/* xl+ only: below that, a fourth link wraps the Russian labels
                ("Приложение для Windows") onto two lines. */}
            <WindowsDownloadLink className="hidden items-center gap-1.5 whitespace-nowrap text-sm text-fg-muted transition-colors duration-150 hover:text-fg xl:inline-flex" />
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />

          <div className="mx-1.5 hidden h-4 w-px bg-edge sm:block" aria-hidden="true" />

          <Link href="/login" className="btn-ghost hidden h-8 sm:inline-flex">
            {t('nav.login')}
          </Link>
          <Link href="/register" className="btn-primary hidden h-8 sm:inline-flex">
            {t('nav.register')}
          </Link>

          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? t('a11y.closeMenu') : t('a11y.openMenu')}
            className="btn-ghost h-8 w-8 p-0 md:hidden"
          >
            {menuOpen ? <X className="h-4 w-4" /> : <MenuIcon className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="animate-fade-in border-t border-edge bg-canvas md:hidden">
          <nav className="mx-auto max-w-shell space-y-0.5 px-4 py-3" aria-label="Mobile">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="block rounded-lg px-3 py-2.5 text-md text-fg-muted transition-colors
 hover:bg-surface-muted hover:text-fg"
              >
                {link.label}
              </Link>
            ))}
            <WindowsDownloadLink
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-md text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
            />
            <div className="grid grid-cols-2 gap-2 pt-2">
              <Link href="/login" onClick={() => setMenuOpen(false)} className="btn-secondary py-2.5">
                {t('nav.login')}
              </Link>
              <Link href="/register" onClick={() => setMenuOpen(false)} className="btn-primary py-2.5">
                {t('nav.register')}
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
