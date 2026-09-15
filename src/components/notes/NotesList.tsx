'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, ShoppingBag, ShoppingCart } from 'lucide-react';
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
/**
 * `canUpload` is the caller's `can(viewer, 'notes:sell')`, the same capability
 * POST /api/notes and /notes/new enforce. It only decides whether the button is
 * offered; the server still refuses an upload from anyone without it.
 *
 * `embedded` drops the page gutter and demotes the heading, for use inside the
 * dashboard, which already provides both.
 */
export function NotesList({
  canUpload = false,
  embedded = false,
}: {
  canUpload?: boolean;
  embedded?: boolean;
} = {}) {
  const t = useT();
  const Heading = embedded ? 'h2' : 'h1';
  const [notes, setNotes] = useState<Note[] | null>(null);
  /** noteId currently being purchased, so only that row shows a spinner. */
  const [buying, setBuying] = useState<string | null>(null);
  /** noteIds this session has successfully bought, for immediate feedback. */
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [buyError, setBuyError] = useState<{ noteId: string; key: string } | null>(null);

  /**
   * Buys a note.
   *
   * The button is per-row rather than on a detail page because the listing is
   * where the decision is made. Idempotency lives on the SERVER - the order's
   * unique (buyerId, noteId) index and derived idempotency key mean a
   * double-click cannot charge twice - so this only needs to stop the UI
   * firing two requests at once.
   */
  async function buy(noteId: string) {
    if (buying) return;
    setBuying(noteId);
    setBuyError(null);
    try {
      const response = await fetch(`/api/notes/${noteId}/purchase`, { method: 'POST' });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // 409 means it is already owned, which is a success from the reader's
        // point of view - the note is theirs and the download works.
        if (response.status === 409) {
          setOwned((prev) => new Set(prev).add(noteId));
          return;
        }
        setBuyError({ noteId, key: payload?.error ?? 'errors.generic' });
        return;
      }

      setOwned((prev) => new Set(prev).add(noteId));
      // Reflect the new purchase count without a refetch of the whole list.
      setNotes((prev) =>
        prev?.map((n) => (n.id === noteId ? { ...n, purchaseCount: n.purchaseCount + 1 } : n)) ?? prev,
      );
    } catch {
      setBuyError({ noteId, key: 'errors.generic' });
    } finally {
      setBuying(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/notes?sort=recent&limit=50', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { notes: [] }))
      .then((body) => setNotes(body.notes ?? []))
      .catch(() => setNotes([]));
    return () => controller.abort();
  }, []);

  return (
    <div className={embedded ? 'w-full' : 'mx-auto w-full max-w-3xl px-4 py-8 sm:px-6'}>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Heading className="text-xl font-bold tracking-tight text-fg">{t('notes.title')}</Heading>
          <p className="mt-0.5 text-sm text-fg-muted">{t('notes.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* The purchases page is the only route to a paid download, so it
              needs a link from here - it was previously reachable by typing
              the URL and nothing else. */}
          <Link href="/notes/purchases" className="btn-secondary">
            <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
            {t('notes.myPurchases')}
          </Link>
          {canUpload && (
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
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <p className="flex gap-3 text-2xs tabular-nums text-fg-subtle">
                <span>{t('notes.stats.downloads').replace('{n}', String(note.downloadCount))}</span>
                <span>{t('notes.stats.purchases').replace('{n}', String(note.purchaseCount))}</span>
                {note.ratingCount > 0 && (
                  <span>
                    {note.ratingAvg.toFixed(1)} ({note.ratingCount})
                  </span>
                )}
              </p>

              <div className="ml-auto flex items-center gap-2">
                {owned.has(note.id) ? (
                  <Link href="/notes/purchases" className="btn-secondary px-3 py-1 text-xs">
                    {t('notes.owned')}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void buy(note.id)}
                    disabled={buying === note.id}
                    className="btn-primary px-3 py-1 text-xs"
                  >
                    {buying === note.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <ShoppingCart className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {note.priceMinor === 0 ? t('notes.buyFree') : t('notes.buy')}
                  </button>
                )}
              </div>
            </div>

            {buyError?.noteId === note.id && (
              <p className="mt-2 text-xs text-danger" role="alert">
                {t(buyError.key)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
