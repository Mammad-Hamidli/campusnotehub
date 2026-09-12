import type { Metadata } from 'next';
import { VerifyDocuments } from '@/components/register/VerifyDocuments';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = {
  title: 'Verification',
  robots: { index: false, follow: false },
};

/** Session state is per-request; this page must never be prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * /verify - document submission for an account that already exists.
 *
 * The verification banner, the rejection notification and the register API's
 * `next.href` all point here, but the route did not exist; the banner linked
 * to /register instead, which the middleware bounces signed-in users away
 * from. So an unverified or rejected account had no way to (re)submit.
 */
export default async function VerifyPage() {
  await requirePageSession('/verify');

  return (
    <main id="main" className="min-h-dvh bg-surface-muted px-4 py-10 sm:py-14">
      <VerifyDocuments />
    </main>
  );
}
