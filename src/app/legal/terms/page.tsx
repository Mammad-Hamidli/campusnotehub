import type { Metadata } from 'next';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';
import { TERMS } from '@/content/legal/terms';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The rules for using CampusHub: accounts, verification, acceptable use, UniNotes, PocketMentor and the wallet.',
  alternates: { canonical: '/legal/terms' },
};

/**
 * /legal/terms - public, linked from the site footer, the sign-up consent
 * checkbox and every transactional email (src/lib/email/layout.ts).
 *
 * The copy is in src/content/legal/terms.ts; this file is only the page frame.
 */
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <LegalDocumentView document={TERMS} slug="terms" />
      </main>
      <SiteFooter />
    </>
  );
}
