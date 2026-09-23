'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Mail, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type Data = { email: string; verified: boolean; verifiedAt: string | null };

/**
 * Settings → Security → Email.
 *
 * Verifying the address is what lets a Google sign-in with the same
 * verified address connect to this account automatically; the panel says so,
 * because otherwise "verify your email" reads as busywork.
 */
export function EmailPanel() {
  const t = useT();
  const [data, setData] = useState<Data | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/me/email', { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setData((await res.json()) as Data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return null;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/email/verification', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body.error ?? 'errors.generic');
      setSent(true);
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-8">
      <section className="card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-md font-medium tracking-tight text-fg">{t('auth.emailVerify.panelTitle')}</h2>
            <p className="mt-1 text-xs text-fg-muted">{t('auth.emailVerify.panelDescription')}</p>
          </div>
          <span
            className={`badge shrink-0 ${
              data.verified ? 'border-verified/30 bg-verified-soft text-verified-fg' : 'border-edge bg-surface-muted text-fg-muted'
            }`}
          >
            {data.verified && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
            {t(data.verified ? 'auth.emailVerify.verified' : 'auth.emailVerify.notVerified')}
          </span>
        </div>

        <p className="mt-4 flex items-center gap-2 text-sm text-fg">
          <Mail className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
          <span className="min-w-0 break-all">{data.email}</span>
        </p>

        {error && (
          <p role="alert" className="alert-danger mt-4">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(error)}</span>
          </p>
        )}

        {!data.verified &&
          (sent ? (
            <p role="status" className="mt-4 text-xs text-fg-muted">
              {t('auth.emailVerify.sent', { email: data.email })}
            </p>
          ) : (
            <button type="button" disabled={busy} onClick={() => void send()} className="btn-primary mt-4 h-8 text-xs">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('auth.emailVerify.send')}
            </button>
          ))}
      </section>
    </div>
  );
}
