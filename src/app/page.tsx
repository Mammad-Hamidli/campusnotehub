import { SiteHeader } from '@/components/marketing/SiteHeader';
import { Hero } from '@/components/marketing/Hero';
import { ActivityTicker } from '@/components/marketing/ActivityTicker';
import { FeatureGrid } from '@/components/marketing/FeatureGrid';
import { CallToAction } from '@/components/marketing/CallToAction';
import { SiteFooter } from '@/components/marketing/SiteFooter';

/**
 * Landing page.
 *
 * A Server Component that composes client children. The page itself ships no
 * JS; only the pieces that genuinely need it (scroll-aware header, count-up
 * stats, language menu, marquee pause) hydrate.
 *
 * When the public stats endpoint lands, fetch it here and pass the numbers
 * down as props — see the integration note in StatsBanner.tsx:
 *
 *   export const revalidate = 900;
 *   const stats = await fetch(`${process.env.APP_URL}/api/stats/public`, {
 *     next: { revalidate: 900 },
 *   }).then((r) => r.json());
 */
export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <ActivityTicker />
        <FeatureGrid />
        <CallToAction />
      </main>
      <SiteFooter />
    </>
  );
}
