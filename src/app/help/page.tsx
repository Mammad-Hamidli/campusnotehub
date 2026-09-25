import type { Metadata } from 'next';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SitePageView } from '@/components/marketing/SitePageView';
import { HELP } from '@/content/site/help';

export const metadata: Metadata = {
  title: 'Help',
  description:
    'Answers about accounts, verification, the feed, UniNotes, PocketMentor and privacy on campusnotehub.',
  alternates: { canonical: '/help' },
};

/** /help - linked from the landing footer. Copy: src/content/site/help.ts. */
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <SitePageView page={HELP} />
      </main>
      <SiteFooter />
    </>
  );
}
