'use client';

import { useState } from 'react';
import { Loader2, Star } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { VERIFICATION_REQUIRED_KEY, VerifyToUnlock } from '@/components/account/VerifyToUnlock';

export type ViewerReview = { eligible: boolean; rating: number | null; body: string | null };

/**
 * The mentee's review box on a mentor's page: 1-5 stars and an optional
 * comment, create or update.
 *
 * Rendered only when the viewer has had a finished session with this mentor
 * (viewerReview.eligible); PUT /api/mentors/:id/reviews re-checks that inside
 * its transaction, so this is never the control. The star input mirrors the
 * notes StarRating so both review surfaces behave the same way.
 */
export function MentorReviewForm({
  mentorId,
  initial,
  onSaved,
}: {
  mentorId: string;
  initial: ViewerReview;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [rating, setRating] = useState(initial.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState(initial.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = initial.rating !== null;
  const dirty = rating !== (initial.rating ?? 0) || body.trim() !== (initial.body ?? '');

  async function submit() {
    if (busy || rating === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mentors/${mentorId}/reviews`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating, body: body.trim() || null }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? 'errors.generic');
      toast.success(t('mentors.reviewForm.saved'));
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'errors.generic');
    } finally {
      setBusy(false);
    }
  }

  const shown = hover || rating;

  return (
    <div className="mt-3 rounded-xl border border-edge bg-surface-muted p-4">
      <p className="text-sm font-medium text-fg">
        {t(existing ? 'mentors.reviewForm.editTitle' : 'mentors.reviewForm.title')}
      </p>

      <div
        role="radiogroup"
        aria-label={t('notes.reviews.rate')}
        className="mt-2 flex"
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={t('notes.reviews.stars', { n })}
            disabled={busy}
            onMouseEnter={() => setHover(n)}
            onClick={() => setRating(n)}
            className="p-0.5 text-warn transition hover:scale-110 disabled:opacity-60"
          >
            <Star className={`h-5 w-5 ${n <= shown ? 'fill-current' : 'text-fg-subtle'}`} aria-hidden="true" />
          </button>
        ))}
      </div>

      <label htmlFor="mentor-review-body" className="sr-only">
        {t('mentors.reviewForm.comment')}
      </label>
      <textarea
        id="mentor-review-body"
        rows={3}
        maxLength={1000}
        value={body}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('mentors.reviewForm.commentPlaceholder')}
        className="input mt-2 resize-none text-sm"
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || rating === 0 || !dirty}
          className="btn-primary h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t(existing ? 'mentors.reviewForm.update' : 'mentors.reviewForm.submit')}
        </button>
      </div>

      {error &&
        (error === VERIFICATION_REQUIRED_KEY ? (
          <VerifyToUnlock className="mt-2" />
        ) : (
          <p role="alert" className="mt-2 text-xs text-danger">
            {t(error)}
          </p>
        ))}
    </div>
  );
}
