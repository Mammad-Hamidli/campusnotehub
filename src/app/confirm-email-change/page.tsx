import type { Metadata } from 'next';
import { ConfirmEmail } from '@/components/auth/ConfirmEmail';

export const metadata: Metadata = {
  title: 'Confirm new email',
  robots: { index: false, follow: false },
  // The token rides in the fragment; nothing outbound needs this URL.
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

/** Lands the link from the emailChangeConfirm mail; see POST /api/me/email/change. */
export default function ConfirmEmailChangePage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <ConfirmEmail kind="change" />
    </main>
  );
}
