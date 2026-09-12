import type { Metadata } from 'next';
import { UserRole } from '@/lib/enums';
import { getAdminViewer } from '@/lib/auth/admin';
import { UniversitiesTable } from '@/components/admin/UniversitiesTable';

export const metadata: Metadata = { title: 'Universities' };

/**
 * `canManage` only decides whether the write controls render. The POST and
 * PATCH handlers re-check the role themselves, so a forged prop changes what
 * the operator sees and nothing about what they can do.
 */
export default async function Page() {
  const viewer = await getAdminViewer();
  return <UniversitiesTable canManage={viewer?.role === UserRole.ADMIN} />;
}
