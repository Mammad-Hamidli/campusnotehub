'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  BadgeCheck,
  Bell,
  BookOpen,
  Bookmark,
  LogOut,
  Menu as MenuIcon,
  MessagesSquare,
  Settings,
  UserRoundSearch,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useT } from '@/lib/i18n/LocaleProvider';

export type DashboardTab = 'feed' | 'notes' | 'mentors' | 'wallet';

const TABS: { tab: DashboardTab; icon: LucideIcon; labelKey: string }[] = [
  { tab: 'feed', icon: MessagesSquare, labelKey: 'nav.feed' },
  { tab: 'notes', icon: BookOpen, labelKey: 'nav.notes' },
  { tab: 'mentors', icon: UserRoundSearch, labelKey: 'nav.mentors' },
  { tab: 'wallet', icon: Wallet, labelKey: 'nav.wallet' },
];

/** Secondary destinations. All resolve to real 200 pages. */
const LINKS: { href: string; icon: LucideIcon; labelKey: string }[] = [
  { href: '/notifications', icon: Bell, labelKey: 'nav.notifications' },
  { href: '/bookmarks', icon: Bookmark, labelKey: 'nav.bookmarks' },
  { href: '/messages', icon: MessagesSquare, labelKey: 'nav.messages' },
];

/**
 * Dashboard rail.
 *
 * Was a slate-950 slab with a filled indigo active state and a gradient
 * avatar. Now it sits on the page canvas with a single right border, and the
 * active item is a subtle inset fill plus a 2px accent bar — readable in both
 * themes without inverting half the screen.
 */
export function Sidebar({
  active,
  onSelect,
  user,
}: {
  active: DashboardTab;
  onSelect: (tab: DashboardTab) => void;
  user: { nickname: string; university: string; verified: boolean; initials: string };
}) {
  const t = useT();
  const [mobileOpen, setMobileOpen] = useState(false);

  const nav = (
    <nav className="space-y-0.5" aria-label="Dashboard">
      {TABS.map(({ tab, icon: Icon, labelKey }) => {
        const isActive = tab === active;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => {
              onSelect(tab);
              setMobileOpen(false);
            }}
            aria-current={isActive ? 'page' : undefined}
            className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm
                        transition-colors duration-150 ${
                          isActive
                            ? 'bg-surface-inset font-medium text-fg'
                            : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                        }`}
          >
            {isActive && (
              <span
                className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-accent"
                aria-hidden="true"
              />
            )}
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{t(labelKey)}</span>
          </button>
        );
      })}

      <div className="my-2 h-px bg-edge" aria-hidden="true" />

      {LINKS.map(({ href, icon: Icon, labelKey }) => (
        <Link
          key={href}
          href={href}
          onClick={() => setMobileOpen(false)}
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg-muted
 transition-colors duration-150 hover:bg-surface-muted hover:text-fg"
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{t(labelKey)}</span>
        </Link>
      ))}
    </nav>
  );

  const account = (
    <Menu
      label={t('a11y.userMenu')}
      align="start"
      width="w-56"
      /**
       * This trigger is the last element of a full-height sidebar, so the
       * default downward panel opened below the viewport and the button looked
       * dead. Stated explicitly rather than left to the auto heuristic,
       * because this is the case the heuristic exists for and a reader should
       * not have to infer it from the button's position.
       */
      placement="top"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          data-menu-trigger
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          className="flex w-full items-center gap-2.5 rounded-lg border border-edge bg-surface p-2
 text-left transition-colors duration-150 hover:bg-surface-muted"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full
 bg-surface-inset text-2xs font-medium text-fg-muted"
            aria-hidden="true"
          >
            {user.initials}
          </span>
          <span className="min-w-0 flex-1">
            {/* The NICKNAME, never the legal name. No shared surface in the
                product displays the name that has to match an ID document. */}
            <span className="flex items-center gap-1">
              <span className="truncate text-xs font-medium text-fg">@{user.nickname}</span>
              {user.verified && (
                <BadgeCheck className="h-3 w-3 shrink-0 text-verified" aria-hidden="true" />
              )}
            </span>
            <span className="block truncate text-2xs text-fg-subtle">{user.university}</span>
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <>
          {/* Rows are links via `href` rather than a <Link> nested inside the
              row's <button>. The nested form is invalid HTML and broke
              cmd-click / middle-click, which on an account menu is exactly how
              people open Settings in a new tab. */}
          <MenuItem href="/profile" icon={<UserRoundSearch className="h-4 w-4" />} onSelect={close}>
            {t('nav.profile')}
          </MenuItem>
          <MenuItem href="/settings" icon={<Settings className="h-4 w-4" />} onSelect={close}>
            {t('nav.settings')}
          </MenuItem>
          <MenuSeparator />
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
  );

  return (
    <>
      {/* Mobile bar. The rail is hidden below lg; duplicating into a sheet
          beats squeezing a 240px rail onto a 360px screen. */}
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-edge bg-canvas/85 px-4 backdrop-blur lg:hidden">
        <Logo />
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? t('a11y.closeMenu') : t('a11y.openMenu')}
            className="btn-ghost h-8 w-8 p-0"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <MenuIcon className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="sticky top-14 z-40 animate-fade-in border-b border-edge bg-canvas p-3 lg:hidden">
          {nav}
          <div className="mt-3">{account}</div>
        </div>
      )}

      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col justify-between border-r border-edge px-3 py-4 lg:flex">
        <div>
          <div className="mb-6 px-2">
            <Logo />
          </div>
          {nav}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1 px-1">
            <LanguageToggle />
            <ThemeToggle />
          </div>
          {account}
        </div>
      </aside>
    </>
  );
}
