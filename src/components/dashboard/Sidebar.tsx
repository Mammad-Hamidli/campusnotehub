'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BadgeCheck,
  Bell,
  BookOpen,
  Bookmark,
  CalendarClock,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu as MenuIcon,
  MessagesSquare,
  Settings,
  UserRoundSearch,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useLiveNotifications } from '@/components/notifications/LiveNotifications';
import { UserRole } from '@/lib/enums';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';

export type DashboardTab = 'feed' | 'notes' | 'saved' | 'mentors' | 'messages';

type RankingData = {
  universities: { code: string; nameAz: string; nameEn: string; nameRu: string; count: number }[];
  topNoteSharers: { id: string; nickname: string; count: number }[];
};

function CommunityRankings() {
  const t = useT();
  const { locale } = useLocale();
  const [data, setData] = useState<RankingData | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/dashboard/rankings', { signal: controller.signal, cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((result: RankingData | null) => { if (result) setData(result); })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (!data) return null;
  const universityName = (u: RankingData['universities'][number]) =>
    locale === 'en' ? u.nameEn : locale === 'ru' ? u.nameRu : u.nameAz;
  const medals = [
    'bg-amber-100 text-amber-800 ring-amber-300',
    'bg-slate-100 text-slate-700 ring-slate-300',
    'bg-orange-100 text-orange-800 ring-orange-300',
  ];

  return (
    <div className="mt-4 space-y-4 border-t border-edge pt-4">
      <section aria-labelledby="university-ranking-title">
        <h2 id="university-ranking-title" className="px-2 text-xs font-semibold text-fg">{t('dashboard.rankings.universities')}</h2>
        <ol className="mt-1 space-y-0.5">
          {data.universities.map((university, index) => (
            <li key={university.code} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs">
              <span className="tabular w-4 shrink-0 text-right text-fg-subtle">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-fg-muted" title={universityName(university)}>{universityName(university)}</span>
              <span className="tabular shrink-0 font-medium text-fg">{university.count}</span>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="note-sharers-title">
        <h2 id="note-sharers-title" className="px-2 text-xs font-semibold text-fg">{t('dashboard.rankings.noteSharers')}</h2>
        <ol className="mt-1 space-y-0.5">
          {data.topNoteSharers.map((user, index) => (
            <li key={user.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs">
              <span role="img" aria-label={t('dashboard.rankings.rank', { rank: index + 1 })} className={`tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold ring-1 ${medals[index] ?? 'bg-surface-inset text-fg-muted ring-edge'}`}>{index + 1}</span>
              <Link href={`/u/${encodeURIComponent(user.nickname)}`} className="min-w-0 flex-1 truncate text-fg-muted hover:text-fg">@{user.nickname}</Link>
              <span className="tabular shrink-0 text-fg-subtle">{user.count}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * `narrowOnly`: the right column carries it from xl up, so the tab exists only below that.
 * `shortKey`: the bottom tab bar's label, short enough for a fifth of a 320px screen.
 */
const TABS: { tab: DashboardTab; icon: LucideIcon; labelKey: string; shortKey: string; narrowOnly?: boolean }[] = [
  { tab: 'feed', icon: MessagesSquare, labelKey: 'nav.feed', shortKey: 'nav.short.feed' },
  { tab: 'notes', icon: BookOpen, labelKey: 'nav.notes', shortKey: 'nav.short.notes' },
  { tab: 'saved', icon: Bookmark, labelKey: 'nav.saved', shortKey: 'nav.short.saved' },
  { tab: 'mentors', icon: UserRoundSearch, labelKey: 'nav.mentors', shortKey: 'nav.short.mentors' },
  { tab: 'messages', icon: Mail, labelKey: 'nav.messages', shortKey: 'nav.short.messages', narrowOnly: true },
];

/** Secondary destinations. All resolve to real 200 pages. */
const LINKS: { href: string; icon: LucideIcon; labelKey: string }[] = [
  { href: '/notifications', icon: Bell, labelKey: 'nav.notifications' },
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
  user: {
    nickname: string;
    university: string;
    verified: boolean;
    initials: string;
    isMentor?: boolean;
    /** Opens the "Mentor panel" link; see mentorConsole in /api/me. */
    mentorConsole?: boolean;
    /** The account's real role (from /api/me); staff get a way back to the panel. */
    role?: string;
  };
}) {
  const t = useT();
  const isStaff = user.role === UserRole.ADMIN || user.role === UserRole.MODERATOR;
  const [mobileOpen, setMobileOpen] = useState(false);
  const live = useLiveNotifications();
  const pending = live.unread + live.followRequests;
  const messageBadge = live.messages.unread + live.messages.requests;
  const links = user.mentorConsole
    ? [{ href: MENTOR_DASHBOARD_PATH, icon: GraduationCap, labelKey: 'nav.mentorPanel' }, ...LINKS]
    : LINKS;

  const select = (tab: DashboardTab) => {
    onSelect(tab);
    setMobileOpen(false);
  };

  const tabs = (
    <nav className="space-y-0.5" aria-label="Dashboard">
      {TABS.map(({ tab, icon: Icon, labelKey, narrowOnly }) => {
        const isActive = tab === active;
        const badge = tab === 'messages' ? messageBadge : 0;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => select(tab)}
            aria-current={isActive ? 'page' : undefined}
            className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm
                        transition-colors duration-150 ${narrowOnly ? 'xl:hidden' : ''} ${
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
            {badge > 0 && (
              <span
                className="ml-auto min-w-5 rounded-full bg-accent px-1.5 text-center text-2xs font-semibold leading-5 text-accent-fg"
                aria-label={t('messages.badge', { count: badge })}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );

  const secondary = (
    <div className="space-y-0.5">
      {links.map(({ href, icon: Icon, labelKey }) => (
        <Link
          key={href}
          href={href}
          onClick={() => setMobileOpen(false)}
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg-muted
 transition-colors duration-150 hover:bg-surface-muted hover:text-fg"
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{t(labelKey)}</span>
          {href === '/notifications' && pending > 0 && (
            <span
              className="ml-auto min-w-5 rounded-full bg-accent px-1.5 text-center text-2xs font-semibold leading-5 text-accent-fg"
              aria-label={t('notifications.unreadCount', { count: pending })}
            >
              {pending > 99 ? '99+' : pending}
            </span>
          )}
        </Link>
      ))}
    </div>
  );

  /**
   * Mobile tab bar. Five equal cells (grid, not flex) so no label can push an
   * icon off-screen; each label truncates inside its own cell, and the icon is
   * a fixed 20px box centred above it. The Messages badge hangs off the icon's
   * corner instead of sitting in the text flow, where it widened its cell.
   */
  const tabBar = (
    <nav
      aria-label="Dashboard"
      data-tab-bar
      className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {TABS.map(({ tab, icon: Icon, shortKey }) => {
          const isActive = tab === active;
          const badge = tab === 'messages' ? messageBadge : 0;
          return (
            <li key={tab} className="min-w-0">
              <button
                type="button"
                onClick={() => select(tab)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex h-14 w-full min-w-0 flex-col items-center justify-center gap-1 px-1 transition-colors duration-150 ${
                  isActive ? 'text-accent' : 'text-fg-muted hover:text-fg'
                }`}
              >
                {isActive && (
                  <span className="absolute inset-x-3 top-0 h-0.5 rounded-b bg-accent" aria-hidden="true" />
                )}
                <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  {badge > 0 && (
                    <span
                      className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[0.625rem] font-semibold leading-4 text-accent-fg"
                      aria-label={t('messages.badge', { count: badge })}
                    >
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </span>
                <span className={`block max-w-full truncate text-2xs leading-none ${isActive ? 'font-semibold' : 'font-medium'}`}>
                  {t(shortKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
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
          {user.isMentor && (
            <MenuItem href="/mentors/schedule" icon={<CalendarClock className="h-4 w-4" />} onSelect={close}>
              {t('nav.mentorSchedule')}
            </MenuItem>
          )}
          <MenuSeparator />
          {/* The mirror of the panel's "Back to app" row, in the same place.
              Shown to both staff tiers, like the panel itself. A staff member
              still owed a second factor is sent on by the /admin layout to set
              one up, which is where they need to go anyway. */}
          {isStaff && (
            <MenuItem href="/admin" icon={<LayoutDashboard className="h-4 w-4" />} onSelect={close}>
              {t('nav.backToAdmin')}
            </MenuItem>
          )}
          <MenuItem
            href="/logout"
            reloadDocument
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
      <div className="sticky top-0 z-40 flex h-14 w-full max-w-full items-center justify-between gap-2 border-b border-edge bg-canvas/85 px-3 backdrop-blur sm:px-4 lg:hidden">
        <div className="min-w-0 shrink">
          <Logo href="/dashboard" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
        // Overlay drawer under the bar: fixed so it does not push the feed down,
        // and scrollable so the account menu stays reachable on short phones.
        // The tabs live in the bottom bar, so the drawer holds the rest.
        <div className="fixed inset-x-0 top-14 z-40 max-h-[calc(100dvh-3.5rem)] animate-fade-in overflow-y-auto border-b border-edge bg-canvas p-3 shadow-raised lg:hidden">
          {secondary}
          <div className="mt-3">{account}</div>
        </div>
      )}

      {tabBar}

  <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col justify-between overflow-y-auto border-r border-edge px-3 py-4 lg:flex">
        <div>
          <div className="mb-6 px-2">
            <Logo href="/dashboard" />
          </div>
          {tabs}
          <div className="my-2 h-px bg-edge" aria-hidden="true" />
          {secondary}
          <CommunityRankings />
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
