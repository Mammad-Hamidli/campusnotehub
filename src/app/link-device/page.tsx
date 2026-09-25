import type { Metadata } from 'next';
import { LinkDevice } from '@/components/auth/LinkDevice';

export const metadata: Metadata = {
  title: 'Sign in with QR code',
  robots: { index: false, follow: false },
  // The token rides in the fragment; nothing outbound needs this URL.
  referrer: 'no-referrer',
};

/** Lands a QR code from Settings -> Devices; see POST /api/me/device-links. */
export default function LinkDevicePage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <LinkDevice />
    </main>
  );
}
