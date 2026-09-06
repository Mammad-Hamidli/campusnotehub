import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuditLogTable } from '@/components/admin/AuditLogTable';

export const metadata: Metadata = { title: 'Audit logs' };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AuditLogTable />
    </Suspense>
  );
}
