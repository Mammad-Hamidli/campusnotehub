'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Loader2, Trash2 } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';

type RequestState = {
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
} | null;

/**
 * Settings -> Account -> Delete account.
 *
 * Files a REQUEST, not a deletion: an administrator reviews it (see
 * /api/me/deletion-request). The card therefore has three faces:
 *
 *   none / cancelled   - the button, which opens the form
 *   rejected           - the admin's reason, and the button again
 *   pending            - "requested on ..., under review" and a cancel button
 *
 * The form asks for the password again: a signed-in browser is not proof the
 * account owner is at it. Kept in its own danger-bordered card, well away from
 * everything else - "delete account" one row below "change password" is how
 * people delete their account by accident.
 */
export function DeletionRequestCard() {
  const t = useT();
  const toast = useToast();
  const { locale } = useLocale();
  const [request, setRequest] = useState<RequestState | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me/deletion-request', { signal: controller.signal, cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { request: null }))
      .then((body) => setRequest(body.request ?? null))
      .catch((cause) => {
        if ((cause as Error)?.name !== 'AbortError') setRequest(null);
      });
    return () => controller.abort();
  }, []);

  const date = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(value)) : '';

  async function call(method: 'POST' | 'DELETE', body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/deletion-request', {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload.error ?? 'errors.generic');
        return;
      }
      setRequest(payload.request ?? null);
      toast.success(t(method === 'POST' ? 'settings.deletion.submitted' : 'settings.deletion.cancelled'));
      setOpen(false);
      setPassword('');
      setReason('');
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  const pending = request?.status === 'PENDING';

  return (
    <div className="rounded-xl border border-danger/30 bg-surface p-6">
      <h2 className="text-sm font-medium text-danger-fg">{t('settings.account.deleteAccount')}</h2>

      {request === undefined ? (
        <div className="mt-3 h-8 w-40 animate-pulse rounded-lg bg-surface-inset" aria-busy="true" />
      ) : pending ? (
        <>
          <p role="status" className="mt-3 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn-fg">
            <Clock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t('settings.deletion.pending', { date: date(request.requestedAt) })}</span>
          </p>
          <button
            type="button"
            onClick={() => void call('DELETE')}
            disabled={busy}
            className="btn-secondary mt-4 h-8 text-xs"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {t('settings.deletion.cancel')}
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">{t('settings.deletion.hint')}</p>

          {request?.status === 'REJECTED' && request.decisionNote && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
              <span className="min-w-0">
                {t('settings.deletion.rejected', { date: date(request.decidedAt) })} {request.decisionNote}
              </span>
            </p>
          )}

          {!open ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="btn-secondary mt-4 h-8 border-danger/40 text-xs text-danger-fg"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t('settings.deletion.request')}
            </button>
          ) : (
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void call('POST', { password, reason: reason.trim() || null });
              }}
            >
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-fg-muted">
                <li>{t('settings.deletion.what.review')}</li>
                <li>{t('settings.deletion.what.signOut')}</li>
                <li>{t('settings.deletion.what.wallet')}</li>
              </ul>

              <div>
                <label htmlFor="deletion-reason" className="mb-1 block text-xs font-medium text-fg">
                  {t('settings.deletion.reason')}{' '}
                  <span className="font-normal text-fg-subtle">({t('common.optional')})</span>
                </label>
                <textarea
                  id="deletion-reason"
                  rows={2}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="input resize-none text-sm"
                />
              </div>

              <div>
                <label htmlFor="deletion-password" className="mb-1 block text-xs font-medium text-fg">
                  {t('settings.deletion.password')}
                </label>
                <input
                  id="deletion-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error === 'settings.deletion.errors.wrongPassword'}
                  className="input text-sm"
                />
              </div>

              {error && (
                <p role="alert" className="text-xs text-danger">
                  {t(error)}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={busy || password.length === 0}
                  className="btn-primary h-8 bg-danger text-xs hover:bg-danger disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {t('settings.deletion.submit')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setError(null);
                    setPassword('');
                  }}
                  className="btn-ghost h-8 text-xs"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {error && !open && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {t(error)}
        </p>
      )}
    </div>
  );
}
