import { Suspense } from 'react';
import type { Metadata } from 'next';
import { VerificationsTable } from '@/components/admin/VerificationsTable';

export const metadata: Metadata = { title: 'Verification' };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <VerificationsTable />
    </Suspense>
  );
}
