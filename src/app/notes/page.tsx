import type { Metadata } from 'next';
import { NotesList } from '@/components/notes/NotesList';

export const metadata: Metadata = { title: 'UniNotes' };

/** Replaces the previous StubPage. Every row comes from the database. */
export default function NotesPage() {
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <NotesList />
    </main>
  );
}
