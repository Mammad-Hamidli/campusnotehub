import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { Hero } from '@/components/marketing/Hero';
import { FeatureGrid } from '@/components/marketing/FeatureGrid';
import { CallToAction } from '@/components/marketing/CallToAction';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { DesktopAppRedirect } from '@/components/marketing/DesktopAppRedirect';
import { getPublicStats } from '@/lib/stats/public';
import { getWindowsInstaller } from '@/lib/desktop/windowsInstaller';
import { COOKIE_REFRESHED, getViewer, sessionClientOf } from '@/lib/auth/session';
import { UserRole } from '@/lib/enums';

/**
 * Landing page.
 *
 * A Server Component that composes client children. The page itself ships no
 * JS; only the pieces that genuinely need it (scroll-aware header, count-up
 * stats, language menu, marquee pause) hydrate.
 *
 * The stats are read here, on the server, from live collections (cached for
 * 15 minutes - see src/lib/stats/public.ts) and handed down as plain props.
 * So is the Windows installer link (cached for 10 minutes - see
 * src/lib/desktop/windowsInstaller.ts); the two lookups run in parallel.
 *
 * A signed-in visitor never sees it: every logo links to "/", and for someone
 * with a live session "/" means their home feed. Decided here with getViewer()
 * (live session row), not in the middleware, for the reason given on the login
 * page - the edge cannot see a revoked session. Signed out costs zero reads.
 */
export default async function HomePage() {
  const viewer = await getViewer();
  if (viewer) {
    redirect(viewer.role === UserRole.ADMIN || viewer.role === UserRole.MODERATOR ? '/admin' : '/dashboard');
  }

  /**
   * Nor does the desktop app, signed in or out: it opens on sign-in. This is
   * where it arrives after signing out (/logout sends everyone to "/") or from
   * a logo click. It goes through /api/auth/desktop rather than straight to
   * /login because an expired access token is not a signed-out user there: the
   * refresh token, which only /api/auth/* can see, may still be good. CH_RF
   * means that route has just renewed the session, so a second bounce would
   * be a loop; /login is the safe answer then.
   */
  const jar = await cookies();
  if (sessionClientOf(jar) === 'desktop') {
    redirect(jar.has(COOKIE_REFRESHED) ? '/login' : '/api/auth/desktop');
  }

  const [stats, installer] = await Promise.all([getPublicStats(), getWindowsInstaller()]);

  return (
    <>
      <DesktopAppRedirect />
      <SiteHeader />
      <main id="main">
        <Hero stats={stats} installer={installer} />
        <FeatureGrid />
        <CallToAction />
      </main>
      <SiteFooter />
    </>
  );
}
