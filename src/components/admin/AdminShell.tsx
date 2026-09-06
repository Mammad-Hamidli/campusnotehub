'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  LayoutDashboard,
  Menu as MenuIcon,
  LogOut,
  ScrollText,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useT } from '@/lib/i18n/LocaleProvider';
import { ToastProvider } from './primitives';

const NAV: { href: string; icon: LucideIcon; labelKey: string }[] = [
  { href: '/admin', icon: LayoutDashboard, labelKey: 'admin.nav.dashboard' },
  { href: '/admin/users', icon: Users, labelKey: 'admin.nav.users' },
  { href: '/admin/verifications', icon: BadgeCheck, labelKey: 'admin.nav.verifications' },
  { href: '/admin/universities', icon: Building2, labelKey: 'admin.nav.universities' },
  { href: '/admin/audit-logs', icon: ScrollText, labelKey: 'admin.nav.auditLogs' },
];

/**
 * The admin chrome.
 *
 * The operator's own profile and settings are reached from the ACCOUNT MENU at
 * the bottom of the rail, not from the main nav. That mirrors the student
 * sidebar exactly - same Menu primitive, same position, same rows - so the two
 * halves of the product feel like one application rather than a panel bolted
 * onto it. They are deliberately not nav items: the nav is the work (users,
 * verifications, audit), and "my own account" is not the work.
 *
 * Those pages cover only what genuinely exists per-operator - appearance,
 * language, session. There is still no platform-configuration model in the
 * schema, and AdminSettings says so rather than rendering toggles that write
 * nowhere.
 *
 * The role badge in the footer is not decoration either. MODERATOR and ADMIN
 * see the same navigation but different buttons on the pages behind it, so
 * "why is Suspend greyed out for me" needs an answer visible on screen.
 */
export function AdminShell({
  children,
  role,
  nickname,
}: {
  children: React.ReactNode;
  role: string;
  nickname: string;
}) {
  const t = useT();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) =>
    href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label={t('admin.nav.label')}>
      {NAV.map(({ href, icon: Icon, labelKey }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setMobileOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-surface-inset font-medium text-fg before:absolute before:left-0 before:top-1.5 before:h-[calc(100%-0.75rem)] before:w-0.5 before:rounded-full before:bg-accent'
                : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t(labelKey)}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <ToastProvider>
      <div className="min-h-dvh bg-surface-muted">
        {/* Skip link: the panel is table-heavy and tabbing past a nav on every
            page is exactly the case skip links exist for. */}
        <a
          href="#admin-main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
        >
          {t('admin.nav.skipToContent')}
        </a>

        <div className="lg:flex">
          {/* Mobile bar */}
          <header className="flex items-center justify-between border-b border-edge bg-surface px-4 py-3 lg:hidden">
            <Logo />
            <button
              type="button"
              onClick={() => setMobileOpen((open) => !open)}
              className="btn-ghost px-2 py-1.5"
              aria-expanded={mobileOpen}
              aria-label={t('admin.nav.label')}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
            </button>
          </header>

          <aside
            className={`${
              mobileOpen ? 'block' : 'hidden'
            } border-b border-edge bg-surface px-4 py-4 lg:sticky lg:top-0 lg:block lg:h-dvh lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r lg:px-3 lg:py-5`}
          >
            <div className="mb-5 hidden items-center gap-2 px-2 lg:flex">
              <Logo />
            </div>

            <p className="mb-2 px-3 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
              {t('admin.nav.section')}
            </p>
            {nav}

            <div className="mt-5 border-t border-edge pt-4">
              {/* Same Menu primitive as the student sidebar, and the same
                  placement="top": this trigger sits at the bottom of a
                  full-height rail, where a downward panel would open below the
                  viewport. */}
              <Menu
                label={t('a11y.userMenu')}
                align="start"
                width="w-56"
                placement="top"
                trigger={({ open, toggle, id }) => (
                  <button
                    type="button"
                    data-menu-trigger
                    onClick={toggle}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={open ? id : undefined}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-edge bg-surface p-2 text-left transition-colors duration-150 hover:bg-surface-muted"
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-inset text-2xs font-medium text-fg-muted"
                      aria-hidden="true"
                    >
                      {nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-fg">@{nickname}</span>
                      <span className="mt-0.5 flex items-center gap-1 text-2xs text-fg-subtle">
                        <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {role}
                      </span>
                    </span>
                  </button>
                )}
              >
                {({ close }) => (
                  <>
                    <MenuItem
                      href="/admin/profile"
                      icon={<UserRound className="h-4 w-4" />}
                      onSelect={close}
                    >
                      {t('admin.profile.title')}
                    </MenuItem>
                    <MenuItem
                      href="/admin/settings"
                      icon={<Settings className="h-4 w-4" />}
                      onSelect={close}
                    >
                      {t('admin.settings.title')}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      href="/dashboard"
                      icon={<ArrowLeft className="h-4 w-4" />}
                      onSelect={close}
                    >
                      {t('admin.nav.backToApp')}
                    </MenuItem>
                    <MenuItem
                      href="/logout"
                      icon={<LogOut className="h-4 w-4" />}
                      onSelect={close}
                      tone="danger"
                    >
                      {t('nav.logout')}
                    </MenuItem>
                  </>
                )}
              </Menu>

              <div className="mt-2 flex items-center gap-1 px-2">
                <ThemeToggle />
                <LanguageToggle />
              </div>
            </div>
          </aside>

          <main id="admin-main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}

/** Page header used by every admin screen, so titles line up across routes. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
