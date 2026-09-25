'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, Loader2, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { SlotPicker } from './SlotPicker';

/**
 * Booking, on the mentor's own profile.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A /bookings PAGE
 * ---------------------------------------------------------------------------
 * The profile previously linked to `/bookings?mentor=<id>`, and /bookings is a
 * StubPage - so the primary call to action on the whole PocketMentor feature
 * led to "not built yet".
 *
 * Almost all of the machinery was already here and untouched by this file:
 * SlotPicker is wired to GET /api/mentors/:id/bookings, slot generation lives
 * in src/lib/mentors/availability.ts, and the POST handler books the slot,
 * holds the money in escrow and creates the meeting room in one transaction.
 * The only missing piece was a surface that put them together.
 *
 * Booking on the profile is also the better placement: the decision is made
 * while reading the mentor's background, so sending the reader to a separate
 * page loses the context they were using to choose.
 */
export function BookingPanel({
  mentorId,
  sessionMinutes,
  onClose,
}: {
  mentorId: string;
  sessionMinutes: number;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();

  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  /**
   * The idempotency key is generated ONCE per panel, not per submit.
   *
   * The booking endpoint requires one and treats it as unique. Generating a
   * fresh value on each click would let an impatient double-tap create two
   * bookings - and two escrow holds - for the same slot. Keying it to the
   * mounted panel means every retry of the same intent carries the same key.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function confirm() {
    if (!startsAt || busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/mentors/${mentorId}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          startsAt,
          topic: topic.trim() || undefined,
          menteeNote: note.trim() || undefined,
          idempotencyKey,
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // The server answers with a locale KEY, so the reason is shown in the
        // reader's own language.
        setError(payload?.error ?? 'errors.generic');
        return;
      }

      setConfirmed(true);
      toast.success(t('mentors.booking.confirmed.body'), { title: t('mentors.booking.confirmed.title') });
      // Refreshes any server-rendered state that depends on the new booking.
      router.refresh();
    } catch {
      setError('errors.generic');
    } finally {
      setBusy(false);
    }
  }

  if (confirmed) {
    return (
      <section className="card mt-3 p-5 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-verified-soft">
          <CalendarCheck className="h-6 w-6 text-verified" aria-hidden="true" />
        </span>
        <h2 className="mt-3 text-base font-semibold text-fg">{t('mentors.booking.confirmed.title')}</h2>
        <p className="mt-1 text-sm text-fg-muted">{t('mentors.booking.confirmed.body')}</p>
        <button type="button" onClick={onClose} className="btn-secondary mt-4 px-4 py-1.5 text-sm">
          {t('common.close')}
        </button>
      </section>
    );
  }

  return (
    <section className="card mt-3 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg">{t('mentors.book')}</h2>
          <p className="mt-0.5 text-xs text-fg-muted">{t('mentors.booking.selectTime')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="btn-ghost -mr-2 -mt-1 h-8 w-8 p-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Existing component, already wired to the real availability endpoint.
          Nothing about slot generation is reimplemented here. */}
      <SlotPicker
        mentorId={mentorId}
        sessionMinutes={sessionMinutes}
        onSelect={setStartsAt}
      />

      {startsAt && (
        <div className="mt-4 space-y-3 border-t border-edge pt-4">
          <label className="block">
            <span className="text-2xs font-medium text-fg-muted">{t('mentors.booking.topic')}</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={120}
              placeholder={t('mentors.booking.topicPlaceholder')}
              className="input mt-1 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-2xs font-medium text-fg-muted">{t('mentors.booking.menteeNote')}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder={t('mentors.booking.menteeNotePlaceholder')}
              className="input mt-1 resize-y py-2 text-sm"
            />
          </label>

          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setStartsAt(null)} className="btn-secondary px-3 py-1.5 text-sm">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={() => void confirm()} disabled={busy} className="btn-primary px-4 py-1.5 text-sm">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('mentors.booking.confirm')}
            </button>
          </div>

          {error && (
            <p className="text-xs text-danger" role="alert">
              {t(error)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
