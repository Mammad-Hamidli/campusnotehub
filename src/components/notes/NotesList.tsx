'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { FileChip } from './FileChip';

type Note = {
  id: string;
  title: string;
  subject: string;
  courseCode: string | null;
  priceMinor: number;
  currency: string;
  ratingAvg: number;
  ratingCount: number;
  purchaseCount: number;
  downloadCount: number;
  publishedAt: string | null;
  university: { code: string } | null;
  seller: { nickname: string; isVerified: boolean };
  attachment: { fileName: string; mime: string; sizeBytes: number } | null;
};

/**
 * The UniNotes listing.
 *
 * Every row is a database row. This replaces a StubPage, and it deliberately
 * has no placeholder content: an empty marketplace renders the empty state,
 * because that is the truth about a new deployment.
 */
export function NotesList() {
  const t = useT();
  const [notes, setNotes] = useState<Note[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/notes?sort=recent&limit=50', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { notes: [] }))
      .then((body) => setNotes(body.notes ?? []))
      .catch(() => setNotes([]));
    return () => controller.abort();
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg">{t('notes.title')}</h1>
          <p className="mt-0.5 text-sm text-fg-muted">{t('notes.subtitle')}</p>
        </div>
        <Link href="/notes/new" className="btn-primary">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('notes.upload.title')}
        </Link>
      </header>

      {notes === null && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-fg-subtle" aria-hidden="true" />
        </div>
      )}

      {notes?.length === 0 && (
        <p className="card p-10 text-center text-sm text-fg-muted">{t('notes.empty')}</p>
      )}

      <ul className="space-y-3">
        {notes?.map((note) => (
          <li key={note.id} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-fg">{note.title}</h2>
                <p className="mt-0.5 text-2xs text-fg-muted">
                  {note.subject}
                  {note.courseCode ? ` · ${note.courseCode}` : ''}
                  {note.university ? ` · ${note.university.code}` : ''}
                  {' · @'}
                  {note.seller.nickname}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-fg">
                {note.priceMinor === 0
                  ? t('notes.free')
                  : `${(note.priceMinor / 100).toFixed(2)} ${note.currency}`}
              </span>
            </div>

            {note.attachment && (
              <div className="mt-3">
                <FileChip
                  noteId={note.id}
                  fileName={note.attachment.fileName}
                  mime={note.attachment.mime}
                  sizeBytes={note.attachment.sizeBytes}
                  downloadLabel={t('notes.download')}
                />
              </div>
            )}

            {/* Real counters from the database. Zero is shown as zero. */}
            <p className="mt-2 flex gap-3 text-2xs tabular-nums text-fg-subtle">
              <span>{t('notes.stats.downloads').replace('{n}', String(note.downloadCount))}</span>
              <span>{t('notes.stats.purchases').replace('{n}', String(note.purchaseCount))}</span>
              {note.ratingCount > 0 && (
                <span>
                  {note.ratingAvg.toFixed(1)} ({note.ratingCount})
                </span>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
