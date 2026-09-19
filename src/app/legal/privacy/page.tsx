import type { Metadata } from 'next';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';
import { PRIVACY } from '@/content/legal/privacy';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'What personal data CampusHub collects, why, how long it is kept, the cookies we use, and your rights.',
  alternates: { canonical: '/legal/privacy' },
};

/**
 * /legal/privacy - public, linked from the site footer, the sign-up consent
 * checkbox and every transactional email (src/lib/email/layout.ts).
 *
 * The copy is in src/content/legal/privacy.ts; this file is only the page frame.
 */
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <LegalDocumentView document={PRIVACY} slug="privacy" />
      </main>
      <SiteFooter />
    </>
  );
}
