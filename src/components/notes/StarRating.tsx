'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * 1-5 star input. Rendered only for verified buyers (viewerOwns); the server
 * re-checks the PAID order, so this is never the control.
 */
export function StarRating({
  noteId,
  initial,
  onRated,
}: {
  noteId: string;
  initial: number | null;
  onRated: (result: { rating: number; ratingAvg: number; ratingCount: number }) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial ?? 0);
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rate(rating: number) {
    if (busy) return;
    const previous = value;
    setValue(rating);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/notes/${noteId}/reviews`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? 'errors.generic');
      onRated(payload);
    } catch (cause) {
      setValue(previous);
      setError(cause instanceof Error ? cause.message : 'errors.generic');
    } finally {
      setBusy(false);
    }
  }

  const shown = hover || value;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-2xs text-fg-muted">
        {value ? t('notes.reviews.yourRating') : t('notes.reviews.rate')}
      </span>
      <div role="radiogroup" aria-label={t('notes.reviews.rate')} className="flex" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={t('notes.reviews.stars', { n })}
            disabled={busy}
            onMouseEnter={() => setHover(n)}
            onClick={() => void rate(n)}
            className="p-0.5 text-warn transition hover:scale-110 disabled:opacity-60"
          >
            <Star className={`h-4 w-4 ${n <= shown ? 'fill-current' : 'text-fg-subtle'}`} aria-hidden="true" />
          </button>
        ))}
      </div>
      {error && (
        <span role="alert" className="text-2xs text-danger">
          {t(error)}
        </span>
      )}
    </div>
  );
}
