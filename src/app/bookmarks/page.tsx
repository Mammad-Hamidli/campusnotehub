import type { Metadata } from 'next';
import { NotesList } from '@/components/notes/NotesList';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = { title: 'Saved items' };

/** Session state is per-request; this page must never be prerendered or cached. */
export const dynamic = 'force-dynamic';

/** Standalone Saved Items (same list as the dashboard's "saved" tab). */
export default async function Page() {
  await requirePageSession('/bookmarks');

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <NotesList source="saved" />
    </main>
  );
}
