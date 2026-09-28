import type { Metadata } from 'next';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SitePageView } from '@/components/marketing/SitePageView';
import { ContactForm } from '@/components/contact/ContactForm';
import { CONTACT } from '@/content/site/contact';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'How to reach the CampusNoteHub team for support, privacy, security and partnerships.',
  alternates: { canonical: '/contact' },
};

/**
 * /contact - linked from the landing footer. Copy: src/content/site/contact.ts.
 * The form above the sections posts to /api/contact, which emails the team.
 */
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <SitePageView page={CONTACT} showContactCta={false}>
          <ContactForm />
        </SitePageView>
      </main>
      <SiteFooter />
    </>
  );
}
