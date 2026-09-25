'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bookmark, BookOpenText, Download, FileText, Loader2, Plus, Star } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { FileChip } from './FileChip';
import { CreatorHandle, type CreatorStats } from './CreatorHandle';
import { StarRating } from './StarRating';

type Note = {
  id: string;
  title: string;
  subject: string;
  courseCode: string | null;
  ratingAvg: number;
  /** Unique reviewers. */
  ratingCount: number;
  downloadCount: number;
  publishedAt: string | null;
  universities: { id: string; code: string }[];
  seller: { nickname: string; isVerified: boolean; stats: CreatorStats | null } | null;
  attachment: { fileName: string; mime: string; sizeBytes: number } | null;
  viewerIsSeller: boolean;
  viewerCanDownload: boolean;
  viewerSaved: boolean;
  viewerRating: number | null;
};

/** Cross-component bookmark sync (listing <-> Saved Items) within the tab. */
export const SAVED_EVENT = 'campusnotehub:note-saved';
type SavedDetail = { noteId: string; saved: boolean };

/**
 * The UniNotes listing, and (source="saved") the dashboard's Saved Items.
 *
 * Notes are free: every signed-in reader can download and rate. The flags
 * come from the server and are only UI hints; the file and review routes
 * re-check the session on each request.
 */
export function NotesList({
  canUpload = false,
  embedded = false,
  source = 'all',
}: {
  canUpload?: boolean;
  embedded?: boolean;
  source?: 'all' | 'saved';
} = {}) {
  const t = useT();
  const toast = useToast();
  const Heading = embedded ? 'h2' : 'h1';
  const [notes, setNotes] = useState<Note[] | null>(null);

  const patch = (noteId: string, change: Partial<Note>) =>
    setNotes((prev) => prev?.map((n) => (n.id === noteId ? { ...n, ...change } : n)) ?? prev);

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetch(source === 'saved' ? '/api/notes/saved' : '/api/notes?sort=recent&limit=50', { signal })
        .then((res) => (res.ok ? res.json() : { notes: [] }))
        .then((body) => setNotes(body.notes ?? []))
        .catch((e) => {
          if ((e as Error)?.name !== 'AbortError') setNotes([]);
        }),
    [source],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Instant sync: another list toggled a bookmark.
  useEffect(() => {
    const onSaved = (event: Event) => {
      const { noteId, saved } = (event as CustomEvent<SavedDetail>).detail;
      if (source === 'saved') {
        if (saved) void load();
        else setNotes((prev) => prev?.filter((n) => n.id !== noteId) ?? prev);
      } else {
        setNotes((prev) => prev?.map((n) => (n.id === noteId ? { ...n, viewerSaved: saved } : n)) ?? prev);
      }
    };
    window.addEventListener(SAVED_EVENT, onSaved);
    return () => window.removeEventListener(SAVED_EVENT, onSaved);
  }, [source, load]);

  async function toggleSaved(note: Note) {
    const next = !note.viewerSaved;
    const broadcast = (saved: boolean) =>
      window.dispatchEvent(new CustomEvent<SavedDetail>(SAVED_EVENT, { detail: { noteId: note.id, saved } }));
    broadcast(next); // optimistic
    try {
      const res = await fetch(`/api/notes/${note.id}/save`, { method: next ? 'PUT' : 'DELETE' });
      if (!res.ok) {
        broadcast(!next);
        toast.error(t('notes.saved.failed'));
        return;
      }
      toast.success(t(next ? 'notes.saved.added' : 'notes.saved.removed'));
    } catch {
      broadcast(!next);
      toast.error(t('notes.saved.failed'));
    }
  }

  return (
    <div className={embedded ? 'w-full' : 'mx-auto w-full max-w-3xl px-4 py-8 sm:px-6'}>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <SectionHeading
          as={Heading}
          icon={source === 'saved' ? Bookmark : BookOpenText}
          title={t(source === 'saved' ? 'notes.saved.title' : 'notes.title')}
          subtitle={t(source === 'saved' ? 'notes.saved.subtitle' : 'notes.subtitle')}
        />
        <div className="flex items-center gap-2">
          {canUpload && source === 'all' && (
            <Link href="/notes/new" className="btn-primary">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('notes.upload.title')}
            </Link>
          )}
        </div>
      </header>

      {notes === null && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-fg-subtle" aria-hidden="true" />
        </div>
      )}

      {notes?.length === 0 && (
        <div className="card flex flex-col items-center p-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft">
            {source === 'saved' ? (
              <Bookmark className="h-6 w-6 text-accent" aria-hidden="true" />
            ) : (
              <BookOpenText className="h-6 w-6 text-accent" aria-hidden="true" />
            )}
          </span>
          <p className="mt-3 text-sm text-fg-muted">
            {t(source === 'saved' ? 'notes.saved.empty' : 'notes.empty')}
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {notes?.map((note) => (
          <li key={note.id} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <FileText className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-fg">{note.title}</h2>
                <p className="mt-0.5 break-words text-2xs text-fg-muted">
                  {note.subject}
                  {note.courseCode ? ` · ${note.courseCode}` : ''}
                  {note.universities.length > 0 ? ` · ${note.universities.map((u) => u.code).join(', ')}` : ''}
                  {note.seller && (
                    <>
                      {' · '}
                      <CreatorHandle nickname={note.seller.nickname} stats={note.seller.stats} />
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void toggleSaved(note)}
                  aria-pressed={note.viewerSaved}
                  aria-label={t(note.viewerSaved ? 'notes.saved.remove' : 'notes.saved.add')}
                  title={t(note.viewerSaved ? 'notes.saved.remove' : 'notes.saved.add')}
                  className={`rounded-lg p-1.5 transition hover:bg-surface-inset ${
                    note.viewerSaved ? 'text-accent' : 'text-fg-subtle hover:text-fg'
                  }`}
                >
                  <Bookmark className={`h-4 w-4 ${note.viewerSaved ? 'fill-current' : ''}`} aria-hidden="true" />
                </button>
              </div>
            </div>

            {note.attachment && (
              <div className="mt-3">
                <FileChip
                  noteId={note.id}
                  fileName={note.attachment.fileName}
                  mime={note.attachment.mime}
                  sizeBytes={note.attachment.sizeBytes}
                  downloadLabel={t('notes.download')}
                  locked={!note.viewerCanDownload}
                  lockedLabel={t('notes.signInToDownload')}
                />
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-3">
              <p className="flex items-center gap-3 text-2xs tabular-nums text-fg-subtle">
                <span className="inline-flex items-center gap-1">
                  <Download className="h-3 w-3" aria-hidden="true" />
                  {t('notes.stats.downloads', { n: note.downloadCount })}
                </span>
                {note.ratingCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Star className="h-3 w-3 fill-current text-warn" aria-hidden="true" />
                    {t('notes.reviews.summary', { avg: note.ratingAvg.toFixed(1), count: note.ratingCount })}
                  </span>
                )}
              </p>

              <div className="ml-auto flex items-center gap-2">
                {!note.viewerIsSeller && note.viewerCanDownload && (
                  <StarRating
                    noteId={note.id}
                    initial={note.viewerRating}
                    onRated={(r) =>
                      patch(note.id, { viewerRating: r.rating, ratingAvg: r.ratingAvg, ratingCount: r.ratingCount })
                    }
                  />
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
