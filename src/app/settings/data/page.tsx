import type { Metadata } from 'next';
import { DataExportPanel } from '@/components/settings/DataExportPanel';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = {
  title: 'Download your data',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Settings -> Account -> Download my data. The row used to point at /help, a
 * placeholder; the export itself is POST /api/me/export.
 */
export default async function DataExportPage() {
  await requirePageSession('/settings/data');

  return (
    <main id="main">
      <DataExportPanel />
    </main>
  );
}
