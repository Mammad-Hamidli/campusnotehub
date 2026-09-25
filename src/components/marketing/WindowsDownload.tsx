'use client';

import { useSyncExternalStore, type MouseEventHandler } from 'react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { WINDOWS_DOWNLOAD_PATH } from '@/lib/site';
import type { WindowsInstaller } from '@/lib/desktop/windowsInstaller';

/**
 * "Download for Windows" entry points: the landing-page button and the smaller
 * header / footer links.
 *
 * Every one of them is a plain <a>, never next/link. The target is a file or a
 * redirect to one, not a page: Link would prefetch it and try to render the
 * response as an RSC payload.
 */

/** The four-pane Windows mark. lucide-react ships no brand icons. */
export function WindowsLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M0 0h7.5v7.5H0zM8.5 0H16v7.5H8.5zM0 8.5h7.5V16H0zM8.5 8.5H16V16H8.5z" />
    </svg>
  );
}

const noopSubscribe = () => () => {};

/**
 * True inside the campusnotehub desktop app (desktop/, Tauri). It loads this
 * same site, and a signed-out launch opens on the landing page, so without
 * this the app would offer to download itself on every start.
 *
 * Tauri injects __TAURI_INTERNALS__ into every page it hosts, remote ones
 * included (the site cannot call anything through it: desktop/ grants no
 * capabilities). The server cannot know, so the server render and hydration
 * say false and the app hides the links right after.
 */
function useInDesktopApp(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => '__TAURI_INTERNALS__' in window,
    () => false,
  );
}

/**
 * Header / footer link to the stable /download/windows redirect. The chrome
 * that renders it appears on every marketing page, most of which never
 * resolve the release, so it cannot know the file URL or whether one exists;
 * the redirect decides (and falls back to the landing page's "coming soon").
 */
export function WindowsDownloadLink({
  className,
  label,
  onClick,
}: {
  className?: string;
  label?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const t = useT();
  const inDesktopApp = useInDesktopApp();
  if (inDesktopApp) return null;

  return (
    <a href={WINDOWS_DOWNLOAD_PATH} onClick={onClick} className={className}>
      <WindowsLogo className="h-3.5 w-3.5 shrink-0" />
      {label ?? t('landing.desktop.short')}
    </a>
  );
}

/**
 * The landing page's button, linked straight to the installer file.
 *
 * `installer` is null until the first desktop release exists (or while GitHub
 * cannot be reached on a cold cache): the slot then says "coming soon" as
 * plain text instead of offering a link that would 404.
 */
export function WindowsDownloadButton({ installer }: { installer: WindowsInstaller | null }) {
  const t = useT();
  const inDesktopApp = useInDesktopApp();
  if (inDesktopApp) return null;

  if (!installer) {
    return (
      <p
        id="download"
        className="inline-flex h-10 scroll-mt-20 items-center gap-2 rounded-full border border-dashed border-edge px-4 text-sm font-medium text-fg-subtle"
      >
        <WindowsLogo className="h-4 w-4 shrink-0" />
        {t('landing.desktop.comingSoon')}
      </p>
    );
  }

  // Whole megabytes, not Intl.NumberFormat(locale): Node formats "az" as 5,1
  // but Chromium, which ships trimmed locale data, as 5.1 - a hydration
  // mismatch. A download label needs no decimal.
  const details = [
    installer.version && t('landing.desktop.version', { version: installer.version }),
    installer.sizeBytes &&
      t('landing.desktop.sizeMb', { size: Math.max(1, Math.round(installer.sizeBytes / 1_048_576)) }),
    t('landing.desktop.requirements'),
  ].filter(Boolean);

  return (
    <div id="download" className="flex scroll-mt-20 flex-wrap items-center gap-x-3 gap-y-2">
      <a href={installer.url} className="btn-secondary h-10 gap-2 rounded-full px-4">
        <WindowsLogo className="h-4 w-4 shrink-0 text-brand" />
        {t('landing.desktop.download')}
      </a>
      <span className="text-xs text-fg-subtle">{details.join(' · ')}</span>
    </div>
  );
}
