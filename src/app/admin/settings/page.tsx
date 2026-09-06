import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getAdminViewer } from '@/lib/auth/admin';
import { AdminSettings } from '@/components/admin/AdminSettings';

export const metadata: Metadata = { title: 'My settings' };

/**
 * Operator preferences.
 *
 * The nickname is read server-side because it is only display chrome - it does
 * not gate anything, so a round trip from the client to fetch it would be a
 * request for nothing. The redirect mirrors the layout's guard for the case
 * where this page is somehow reached without one.
 */
export default async function AdminSettingsPage() {
  const viewer = await getAdminViewer();
  if (!viewer) redirect('/dashboard');

  const account = await db.user.findUnique({
    where: { id: viewer.id },
    select: { nickname: true },
  });

  return <AdminSettings nickname={account?.nickname ?? '—'} />;
}
