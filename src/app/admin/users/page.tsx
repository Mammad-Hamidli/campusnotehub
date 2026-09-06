import { Suspense } from 'react';
import type { Metadata } from 'next';
import { UsersTable } from '@/components/admin/UsersTable';

export const metadata: Metadata = { title: 'Users' };

/**
 * Replaces the previous StubPage. The Suspense boundary is required because
 * UsersTable reads useSearchParams - filter state lives in the URL so a view
 * can be linked and the back button steps through filters.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <UsersTable />
    </Suspense>
  );
}
