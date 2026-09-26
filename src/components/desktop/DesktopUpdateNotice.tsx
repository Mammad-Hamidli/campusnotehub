'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { desktopAppVersion, isNewerVersion, type DesktopRelease } from '@/lib/desktop/appVersion';

/**
 * "A new version is available" card, shown only inside the desktop app.
 *
 * The site itself deploys continuously and needs no prompt; what goes stale is
 * the installed shell (window behaviour, sign-in persistence, link handling).
 * In a browser this renders nothing and makes no request: detection is a
 * synchronous check of what the shell injected (src/lib/desktop/appVersion.ts).
 *
 * Checks on start, whenever the window comes back into view, and hourly while
 * it stays open. "Later" snoozes that one version for a few days; a newer
 * release shows straight away. "Download" hands the installer to WebView2's
 * download flyout; the NSIS setup closes the running app itself.
 */

const RECHECK_MS = 60 * 60 * 1000;
/** Floor between checks, so alt-tabbing back and forth does not refetch. */
const MIN_GAP_MS = 15 * 60 * 1000;
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const SNOOZE_KEY = 'ch:desktop-update-snooze';

const noopSubscribe = () => () => {};

function isSnoozed(version: string): boolean {
  try {
    const snooze = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? 'null') as { version: string; until: number } | null;
    return snooze?.version === version && Date.now() < snooze.until;
  } catch {
    return false;
  }
}

function snooze(version: string) {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version, until: Date.now() + SNOOZE_MS }));
  } catch {
    // Storage blocked: the card just comes back on the next check.
  }
}

export function DesktopUpdateNotice() {
  const t = useT();
  const current = useSyncExternalStore(noopSubscribe, desktopAppVersion, () => null);
  const [release, setRelease] = useState<DesktopRelease | null>(null);

  useEffect(() => {
    if (!current) return;
    let lastCheck = 0;
    let active = true;

    const check = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < MIN_GAP_MS) return;
      lastCheck = Date.now();
      try {
        const response = await fetch('/api/desktop/release');
        if (!response.ok) return;
        const latest = (await response.json()) as DesktopRelease | null;
        if (active && latest && isNewerVersion(latest.version, current) && !isSnoozed(latest.version)) {
          setRelease(latest);
        }
      } catch {
        // Offline or the site is deploying: the next trigger tries again.
      }
    };

    void check();
    const timer = setInterval(check, RECHECK_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [current]);

  if (!release) return null;

  const later = () => {
    snooze(release.version);
    setRelease(null);
  };

  return (
    <div
      role="status"
      className="overlay fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex animate-rise
                 items-start gap-3 p-4 text-sm sm:inset-x-auto sm:bottom-6 sm:left-6 sm:w-[22rem]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
        <Download className="h-4 w-4 text-accent" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-fg">{t('desktopUpdate.title')}</p>
        <p className="mt-0.5 text-fg-muted">{t('desktopUpdate.body', { version: release.version })}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {/* A plain <a>: the target is a file, not a page. Not snoozed, so
              a cancelled download is offered again next time. */}
          <a href={release.url} onClick={() => setRelease(null)} className="btn-primary">
            {t('desktopUpdate.download')}
          </a>
          <button type="button" onClick={later} className="btn-ghost">
            {t('desktopUpdate.later')}
          </button>
        </div>
      </div>
    </div>
  );
}
