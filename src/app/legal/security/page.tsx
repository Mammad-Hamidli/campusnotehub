import type { Metadata } from 'next';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SitePageView } from '@/components/marketing/SitePageView';
import { SAFETY } from '@/content/site/safety';

export const metadata: Metadata = {
  title: 'Safety and security',
  description:
    'How campusnotehub protects accounts and personal data, and how to stay safe and report a problem.',
  alternates: { canonical: '/legal/security' },
};

/**
 * /legal/security - "Security" in the footer's legal column. Not a legal
 * document, so it uses the plain page view rather than LegalDocumentView.
 * Copy: src/content/site/safety.ts.
 */
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <SitePageView page={SAFETY} />
      </main>
      <SiteFooter />
    </>
  );
}
