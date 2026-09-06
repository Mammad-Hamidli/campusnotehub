import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getViewer } from '@/lib/auth/session';
import { NoteUploadForm } from '@/components/notes/NoteUploadForm';

export const metadata: Metadata = {
  title: 'Upload note',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * The university list is loaded server-side because it is reference data every
 * visitor may see. The upload itself is authorized in POST /api/notes, which
 * re-checks the session and the `notes:sell` capability - this page's redirect
 * is convenience, not the control.
 */
export default async function NewNotePage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?next=/notes/new');

  const universities = await db.university.findMany({
    where: { isActive: true },
    orderBy: { code: 'asc' },
    select: { id: true, code: true },
  });

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <NoteUploadForm universities={universities} />
    </main>
  );
}
