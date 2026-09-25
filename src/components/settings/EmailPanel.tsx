'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Loader2, Mail, MailCheck, Pencil, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type Data = { email: string; verified: boolean; verifiedAt: string | null };

/**
 * Settings → Security → Email.
 *
 * Verifying the address is what lets a Google sign-in with the same
 * verified address connect to this account automatically; the panel says so,
 * because otherwise "verify your email" reads as busywork.
 *
 * Changing it is two proofs (POST /api/me/email/change): the holder re-proves
 * themselves here - password, or authenticator code when 2FA is on - then
 * confirms from the NEW inbox while signed in. Until then nothing moves.
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

        <EmailChange current={data.email} />

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

type Reauth = 'code' | 'password' | 'recent_sign_in';

function EmailChange({ current }: { current: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reauth, setReauth] = useState<Reauth>('password');
  const [newEmail, setNewEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/me/email/change', { signal: controller.signal, cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { reauth?: Reauth } | null) => {
        if (body?.reauth) setReauth(body.reauth);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const proof =
      reauth === 'code' ? { code: secret.replace(/\s/g, '') } : reauth === 'password' ? { password: secret } : {};
    try {
      const res = await fetch('/api/me/email/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newEmail: newEmail.trim(), ...proof }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const field = body.fields?.newEmail?.[0] as string | undefined;
        setError(field ?? body.error ?? 'errors.generic');
        return;
      }
      setPending(body.pendingEmail ?? newEmail.trim());
      setSecret('');
      setOpen(false);
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <p role="status" className="mt-4 flex items-start gap-2 rounded-lg bg-accent-soft px-3 py-2.5 text-xs text-fg">
        <MailCheck className="mt-px h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0">{t('settings.email.pending', { email: pending })}</span>
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary mt-4 h-8 text-xs">
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        {t('settings.email.change')}
      </button>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 space-y-3 rounded-lg border border-edge p-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-fg">{t('settings.email.newLabel')}</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={newEmail}
          placeholder={current}
          onChange={(e) => setNewEmail(e.target.value)}
          className="input"
        />
      </label>

      {reauth === 'recent_sign_in' ? (
        <p className="text-xs leading-relaxed text-fg-muted">{t('auth.reauth.recentHint')}</p>
      ) : (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-fg">
            {t(reauth === 'code' ? 'auth.mfa.codeLabel' : 'settings.email.currentPassword')}
          </span>
          <input
            type={reauth === 'code' ? 'text' : 'password'}
            inputMode={reauth === 'code' ? 'numeric' : undefined}
            autoComplete={reauth === 'code' ? 'one-time-code' : 'current-password'}
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="input"
          />
        </label>
      )}

      <p className="text-2xs leading-relaxed text-fg-muted">{t('settings.email.changeHint')}</p>

      {error && (
        <p role="alert" className="alert-danger">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{t(error)}</span>
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !newEmail.trim() || (reauth !== 'recent_sign_in' && !secret)}
          className="btn-primary h-8 text-xs"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {t('settings.email.sendLink')}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="btn-ghost h-8 text-xs"
        >
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
