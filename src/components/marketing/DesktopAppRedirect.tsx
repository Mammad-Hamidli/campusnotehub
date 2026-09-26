'use client';

import { useEffect } from 'react';
import { isDesktopApp } from '@/lib/desktop/appVersion';

/**
 * Sends the desktop app from the landing page to its own start route.
 *
 * Current builds of the app open on /api/auth/desktop, and once that route has
 * marked the app's cookie jar the server keeps it off this page (see
 * app/page.tsx). Installs from before that change still open on "/" with no
 * marker, and the server cannot tell them from a browser - only the page can,
 * through the same check WindowsDownload uses. One hop here and they get the
 * desktop behaviour without reinstalling.
 */
export function DesktopAppRedirect() {
  useEffect(() => {
    if (isDesktopApp()) window.location.replace('/api/auth/desktop');
  }, []);
  return null;
}
