import type { Metadata } from 'next';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SitePageView } from '@/components/marketing/SitePageView';
import { ABOUT } from '@/content/site/about';

export const metadata: Metadata = {
  title: 'About',
  description:
    'campusnotehub is the social platform for university students and graduates in Azerbaijan: the campus feed, free class notes and mentoring.',
  alternates: { canonical: '/about' },
};

/** /about - linked from the landing header and footer. Copy: src/content/site/about.ts. */
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <SitePageView page={ABOUT} />
      </main>
      <SiteFooter />
    </>
  );
}
