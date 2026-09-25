import { redirect } from 'next/navigation';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { Hero } from '@/components/marketing/Hero';
import { FeatureGrid } from '@/components/marketing/FeatureGrid';
import { CallToAction } from '@/components/marketing/CallToAction';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { getPublicStats } from '@/lib/stats/public';
import { getViewer } from '@/lib/auth/session';
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

  const stats = await getPublicStats();

  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero stats={stats} />
        <FeatureGrid />
        <CallToAction />
      </main>
      <SiteFooter />
    </>
  );
}
