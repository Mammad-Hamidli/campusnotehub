import { NextResponse } from 'next/server';
import type { DesktopRelease } from '@/lib/desktop/appVersion';
import { getWindowsInstaller } from '@/lib/desktop/windowsInstaller';

/**
 * GET /api/desktop/release - the newest Windows installer, for the desktop
 * app's update notice (src/components/desktop/DesktopUpdateNotice.tsx).
 *
 * `null` when there is nothing to compare against: no release yet, GitHub
 * unreachable on a cold cache, or WINDOWS_INSTALLER_URL set (which carries no
 * version). The lookup itself is cached for 10 minutes server-side; the CDN
 * and the app's own HTTP cache sit in front of that, so a fleet of open
 * windows polling hourly costs next to nothing. Public: signed-out app
 * windows (the sign-in screen) should be told too.
 */
export async function GET() {
  const installer = await getWindowsInstaller();
  const release: DesktopRelease | null = installer?.version
    ? { version: installer.version, url: installer.url, sizeBytes: installer.sizeBytes }
    : null;
  return NextResponse.json(release, {
    headers: { 'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600' },
  });
}
