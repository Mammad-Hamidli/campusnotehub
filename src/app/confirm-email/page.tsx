import type { Metadata } from 'next';
import { ConfirmEmail } from '@/components/auth/ConfirmEmail';

export const metadata: Metadata = {
  title: 'Confirm email',
  robots: { index: false, follow: false },
  // The link that led here carried a token (in the fragment, which browsers
  // never send as a referrer anyway); no outbound request needs this URL.
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

/**
 * Deliberately NOT under /verify, which the middleware protects: a signed-out
 * visitor must reach this page so it can stash the token before signing in.
 * The page itself grants nothing; the API it calls requires the session.
 */
export default function ConfirmEmailPage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <ConfirmEmail />
    </main>
  );
}
