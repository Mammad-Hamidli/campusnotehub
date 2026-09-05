import type { Metadata } from 'next';
import { RegisterAside } from '@/components/register/RegisterAside';
import { RegisterWizard } from '@/components/register/RegisterWizard';

export const metadata: Metadata = {
  title: 'Qeydiyyat',
  // The registration flow handles national ID images. Keep it out of every
  // index, including link previews.
  robots: { index: false, follow: false },
};

/**
 * Two-pane registration.
 *
 * The dark aside is not decoration: asking a 19-year-old to photograph their
 * national ID is a big ask, and the reasons have to be visible on the same
 * screen as the request. Burying "why we need this" behind a tooltip is how
 * you get a 40% drop-off at step two.
 *
 * The aside collapses on mobile to a compact strip above the form so the
 * reasoning survives the smaller viewport instead of being hidden entirely.
 */
export default function RegisterPage() {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <RegisterAside />

      <main id="main" className="flex flex-1 items-start justify-center px-4 py-10 sm:px-8 lg:py-16">
        <RegisterWizard />
      </main>
    </div>
  );
}
