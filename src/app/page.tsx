import { SiteHeader } from '@/components/marketing/SiteHeader';
import { Hero } from '@/components/marketing/Hero';
import { FeatureGrid } from '@/components/marketing/FeatureGrid';
import { CallToAction } from '@/components/marketing/CallToAction';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { getPublicStats } from '@/lib/stats/public';

/**
 * Landing page.
 *
 * A Server Component that composes client children. The page itself ships no
 * JS; only the pieces that genuinely need it (scroll-aware header, count-up
 * stats, language menu, marquee pause) hydrate.
 *
 * The stats are read here, on the server, from live collections (cached for
 * 15 minutes - see src/lib/stats/public.ts) and handed down as plain props.
 */
export default async function HomePage() {
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
