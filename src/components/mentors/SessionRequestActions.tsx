'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Loader2, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { REJECTION_REASON_MAX, REJECTION_REASON_MIN } from '@/lib/mentors/requests';

export type RequestOutcome = 'CONFIRMED' | 'REJECTED' | 'GONE';

/** Answers that mean "this request is no longer yours to answer". */
const GONE_STATUSES = new Set([404, 409, 410]);
const GONE_ERRORS = new Set(['errors.notFound', 'mentors.requests.errors.alreadyAnswered', 'mentors.requests.errors.expired']);

/**
 * Accept / Decline for one session request - on the BOOKING_REQUESTED
 * notification, the mentor panel and the session page.
 *
 * Declining asks for a reason, required and 10-500 characters (the same rule
 * the server enforces in respondSchema): the mentee is told why, which is
 * what turns a "no" into a next step.
 *
 * Accepting needs the mentor's Google Calendar (the Meet room is created on
 * it). When it is not connected the button is replaced by a link to connect
 * it, rather than letting the mentor press Accept and be refused.
 *
 * `onAnswered` defaults to refreshing the server-rendered page around it.
 */
export function SessionRequestActions({
  bookingId,
  calendarConnected,
  onAnswered,
}: {
  bookingId: string;
  calendarConnected: boolean;
  onAnswered?: (outcome: RequestOutcome) => void;
}) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const reasonId = useId();
  const [mode, setMode] = useState<'idle' | 'declining'>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = (outcome: RequestOutcome) => (onAnswered ? onAnswered(outcome) : router.refresh());
  const reasonLength = reason.trim().length;
  const reasonValid = reasonLength >= REJECTION_REASON_MIN && reasonLength <= REJECTION_REASON_MAX;

  async function respond(action: 'accept' | 'reject') {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'accept' ? { action } : { action, reason: reason.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        meetingStatus?: string;
        error?: string;
        params?: Record<string, string | number>;
      };

      if (response.ok && body.status === 'CONFIRMED') {
        toast.success(t('mentors.requests.accepted'));
        if (body.meetingStatus !== 'READY') toast.info(t('mentors.requests.meetingPending'));
        done('CONFIRMED');
        return;
      }
      if (response.ok && body.status === 'REJECTED') {
        toast.success(t('mentors.requests.declined'));
        done('REJECTED');
        return;
      }
      if (GONE_STATUSES.has(response.status) && body.error && GONE_ERRORS.has(body.error)) {
        toast.info(t(body.error));
        done('GONE');
        return;
      }
      setError(body.error ?? 'errors.generic');
    } catch {
      setError('errors.network');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      {mode === 'idle' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {calendarConnected ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void respond('accept')}
              className="btn-primary h-8 px-3 text-xs"
            >
              {busy === 'accept' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {t('mentors.requests.accept')}
            </button>
          ) : (
            <Link href="/mentors/dashboard#calendar" className="btn-primary h-8 px-3 text-xs">
              {t('mentors.requests.connectToAccept')}
            </Link>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setMode('declining')}
            className="btn-secondary h-8 px-3 text-xs"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('mentors.requests.decline')}
          </button>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reasonValid) void respond('reject');
          }}
        >
          <label htmlFor={reasonId} className="block text-2xs font-medium text-fg-muted">
            {t('mentors.requests.reasonLabel')}
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={REJECTION_REASON_MAX}
            required
            minLength={REJECTION_REASON_MIN}
            placeholder={t('mentors.requests.reasonPlaceholder')}
            className="input resize-y py-2 text-sm"
            autoFocus
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`text-2xs ${reasonValid || reasonLength === 0 ? 'text-fg-subtle' : 'text-danger'}`}>
              {t('mentors.requests.reasonHint', { min: REJECTION_REASON_MIN, count: reasonLength })}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setMode('idle');
                  setError(null);
                }}
                className="btn-secondary h-8 px-3 text-xs"
              >
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={!reasonValid || busy !== null} className="btn-primary h-8 px-3 text-xs">
                {busy === 'reject' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('mentors.requests.sendDecline')}
              </button>
            </div>
          </div>
        </form>
      )}

      {error && (
        <p className="text-xs text-danger" role="alert">
          {t(error)}{' '}
          {error === 'mentors.requests.errors.calendarRequired' && (
            <Link href="/mentors/dashboard#calendar" className="font-medium underline">
              {t('mentors.requests.connectCalendar')}
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
