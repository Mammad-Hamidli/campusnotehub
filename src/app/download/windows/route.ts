import { NextResponse, type NextRequest } from 'next/server';
import { getWindowsInstaller } from '@/lib/desktop/windowsInstaller';

/**
 * GET /download/windows - a stable, shareable link to the current installer.
 *
 * The header and footer link here instead of to the file: they render on every
 * marketing page, and resolving the release there would mean a lookup on
 * pages that have no other reason to make one. The landing page, which already
 * resolves it for the version label, links to the file directly.
 *
 * With nothing to download yet it lands on the landing page's download area,
 * which says "coming soon", rather than on a GitHub 404.
 */
export async function GET(request: NextRequest) {
  const installer = await getWindowsInstaller();
  const target = installer ? installer.url : '/#download';
  const response = NextResponse.redirect(new URL(target, request.url), 302);
  // The target changes with every release; never let a proxy pin an old one.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
