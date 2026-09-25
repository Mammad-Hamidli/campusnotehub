import type { Metadata } from 'next';
import { NotesList } from '@/components/notes/NotesList';
import { getViewer } from '@/lib/auth/session';
import { can } from '@/lib/permissions';

export const metadata: Metadata = { title: 'UniNotes' };

/** Reads the session to decide whether to offer uploading, so never prerendered. */
export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage. Every row comes from the database.
 *
 * Browsing stays open to signed-out visitors (`notes:browse`); the create
 * button is offered only to viewers holding `notes:share`.
 */
export default async function NotesPage() {
  const viewer = await getViewer();
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <NotesList canUpload={can(viewer, 'notes:share')} />
    </main>
  );
}
