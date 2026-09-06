import type { Metadata } from 'next';
import { UserDetail } from '@/components/admin/UserDetail';

export const metadata: Metadata = { title: 'User' };

/**
 * The id is taken from the route and handed to the client component, which
 * fetches through /api/admin/users/:id. That endpoint re-authorizes and writes
 * an ADMIN_USER_VIEWED audit row, so an IDOR attempt against another id is
 * both refused and recorded.
 */
export default async function Page({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return <UserDetail userId={userId} />;
}
