import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';

export const metadata: Metadata = {
  title: 'Reset password',
  robots: { index: false, follow: false },
  // The link that led here carried a token (in the fragment, which browsers
  // never send as a referrer anyway); no outbound request needs this URL.
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

/** Public on purpose: the person who needs it cannot sign in. The API it calls checks the token. */
export default function ResetPasswordPage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <ResetPasswordForm />
    </main>
  );
}
