import type { Metadata } from 'next';
import { AdminProfile } from '@/components/admin/AdminProfile';

export const metadata: Metadata = { title: 'My profile' };

/**
 * The operator's own account, inside the admin chrome.
 *
 * Authorization is the /admin layout's job - it runs getAdminViewer() against
 * live database state before any page under this segment renders, and the
 * layout already forces dynamic rendering with no caching. Repeating the check
 * here would be a second copy of a guard that is easy to get subtly different.
 */
export default function AdminProfilePage() {
  return <AdminProfile />;
}
