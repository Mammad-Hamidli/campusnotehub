import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { findUserById } from '@/lib/firebase/repositories/users';
import { getAdminViewer } from '@/lib/auth/admin';
import { AdminShell } from '@/components/admin/AdminShell';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  // The panel lists real accounts. It must never reach an index, and a crawler
  // that follows a link out of it should not carry the referrer either.
  robots: { index: false, follow: false, nocache: true },
};

/** Nothing under /admin may be statically rendered or cached. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The server-side gate for every /admin page.
 *
 * This is the second of three layers, and the first one that can actually see
 * a role:
 *
 *   1. middleware.ts - runs at the edge with no database. Proves the request
 *      carries a valid, unexpired session and nothing more.
 *   2. THIS LAYOUT - reads live account state through getAdminViewer(), so a
 *      moderator demoted a moment ago is redirected on their next navigation
 *      rather than when their token expires.
 *   3. Every /api/admin handler re-checks independently via withAdmin().
 *
 * Layer 3 is the one that actually protects the data. A page shell can be
 * bypassed by calling the API directly, so this layout is a usability and
 * defence-in-depth measure, NOT the security boundary - which is why no admin
 * page fetches privileged data during server render and hands it to the client
 * as props. Every screen loads through the audited, separately-authorized API.
 *
 * A non-staff visitor is sent to /dashboard rather than shown a 403. Confirming
 * "this path exists but you may not have it" tells an attacker the panel is
 * there; a redirect to their own home page tells them nothing.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getAdminViewer();
  if (!viewer) redirect('/dashboard');

  // The shell shows who is signed in and at what tier, so an operator can tell
  // why an action is unavailable to them. Nickname is public by design.
  const account = await findUserById(viewer.id);

  return (
    <AdminShell role={viewer.role} nickname={account?.nickname ?? '—'}>
      {children}
    </AdminShell>
  );
}
