'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bookmark, Loader2, Plus, ShoppingBag, ShoppingCart, Star } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { VERIFICATION_REQUIRED_KEY, VerifyToUnlock } from '@/components/account/VerifyToUnlock';
import { FileChip } from './FileChip';
import { CreatorHandle, type CreatorStats } from './CreatorHandle';
import { StarRating } from './StarRating';

type Note = {
  id: string;
  title: string;
  subject: string;
  courseCode: string | null;
  priceMinor: number;
  currency: string;
  ratingAvg: number;
  /** Unique reviewers. */
  ratingCount: number;
  purchaseCount: number;
  publishedAt: string | null;
  universities: { id: string; code: string }[];
  seller: { nickname: string; isVerified: boolean; stats: CreatorStats | null } | null;
  attachment: { fileName: string; mime: string; sizeBytes: number } | null;
  viewerIsSeller: boolean;
  viewerOwns: boolean;
  viewerCanDownload: boolean;
  viewerSaved: boolean;
  viewerRating: number | null;
};

/** Cross-component bookmark sync (listing <-> Saved Items) within the tab. */
export const SAVED_EVENT = 'campushub:note-saved';
type SavedDetail = { noteId: string; saved: boolean };

/**
 * The UniNotes listing, and (source="saved") the dashboard's Saved Items.
 *
 * Every flag that gates an action (viewerCanDownload, viewerOwns) comes from
 * the server and is only a UI hint: the file and review routes re-check the
 * PAID order on each request.
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
  const [buying, setBuying] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<{ noteId: string; key: string } | null>(null);

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

  /** Server-side idempotent (derived order id); this only prevents double requests. */
  async function buy(noteId: string) {
    if (buying) return;
    setBuying(noteId);
    setBuyError(null);
    try {
      const response = await fetch(`/api/notes/${noteId}/purchase`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok && response.status !== 409) {
        setBuyError({ noteId, key: payload?.error ?? 'errors.generic' });
        return;
      }
      setNotes(
        (prev) =>
          prev?.map((n) =>
            n.id === noteId
              ? {
                  ...n,
                  viewerOwns: true,
                  viewerCanDownload: true,
                  purchaseCount: n.purchaseCount + (response.ok ? 1 : 0),
                }
              : n,
          ) ?? prev,
      );
      // 409 means it was already owned - the card is corrected silently.
      if (response.ok) toast.success(t('notes.purchased'));
    } catch {
      setBuyError({ noteId, key: 'errors.generic' });
    } finally {
      setBuying(null);
    }
  }

  return (
    <div className={embedded ? 'w-full' : 'mx-auto w-full max-w-3xl px-4 py-8 sm:px-6'}>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Heading className="text-xl font-bold tracking-tight text-fg">
            {t(source === 'saved' ? 'notes.saved.title' : 'notes.title')}
          </Heading>
          <p className="mt-0.5 text-sm text-fg-muted">
            {t(source === 'saved' ? 'notes.saved.subtitle' : 'notes.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/notes/purchases" className="btn-secondary">
            <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
            {t('notes.myPurchases')}
          </Link>
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
        <p className="card p-10 text-center text-sm text-fg-muted">
          {t(source === 'saved' ? 'notes.saved.empty' : 'notes.empty')}
        </p>
      )}

      <ul className="space-y-3">
        {notes?.map((note) => (
          <li key={note.id} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
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
                <span className="text-sm font-semibold tabular-nums text-fg">
                  {note.priceMinor === 0
                    ? t('notes.free')
                    : `${(note.priceMinor / 100).toFixed(2)} ${note.currency}`}
                </span>
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
                  lockedLabel={t('notes.lockedUntilPurchase')}
                />
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-3">
              <p className="flex items-center gap-3 text-2xs tabular-nums text-fg-subtle">
                <span>{t('notes.stats.purchases', { n: note.purchaseCount })}</span>
                {note.ratingCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Star className="h-3 w-3 fill-current text-warn" aria-hidden="true" />
                    {t('notes.reviews.summary', { avg: note.ratingAvg.toFixed(1), count: note.ratingCount })}
                  </span>
                )}
              </p>

              <div className="ml-auto flex items-center gap-2">
                {note.viewerIsSeller ? null : note.viewerOwns ? (
                  <StarRating
                    noteId={note.id}
                    initial={note.viewerRating}
                    onRated={(r) =>
                      patch(note.id, { viewerRating: r.rating, ratingAvg: r.ratingAvg, ratingCount: r.ratingCount })
                    }
                  />
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

            {buyError?.noteId === note.id &&
              (buyError.key === VERIFICATION_REQUIRED_KEY ? (
                <VerifyToUnlock className="mt-2" />
              ) : (
                <p className="mt-2 text-xs text-danger" role="alert">
                  {t(buyError.key)}
                </p>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
