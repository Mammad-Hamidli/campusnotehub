'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * Settings → Security → Password. `id="password"` is the anchor the settings
 * page's "Change password" row links to.
 *
 * An account created through Google has no password, and this panel says so
 * rather than offering a form that can only fail.
 */
export function PasswordPanel() {
  const t = useT();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void fetch('/api/me/password', { cache: 'no-store' })
      .then(async (res) => (res.ok ? setHasPassword(((await res.json()) as { hasPassword: boolean }).hasPassword) : null))
      .catch(() => null);
  }, []);

  if (hasPassword === null) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (next !== confirm) return setError('auth.errors.passwordMismatch');
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch('/api/me/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body.error ?? 'errors.generic');
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="password" className="mx-auto w-full max-w-xl scroll-mt-20 px-4 pb-8">
      <section className="card p-6">
        <h2 className="text-md font-medium tracking-tight text-fg">{t('auth.password.changeTitle')}</h2>
        <p className="mt-1 text-xs text-fg-muted">
          {t(hasPassword ? 'auth.password.changeDescription' : 'auth.password.errors.noPassword')}
        </p>

        {hasPassword && (
          <form method="post" onSubmit={submit} className="mt-4 space-y-3" noValidate>
            {error && (
              <p role="alert" className="alert-danger">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{t(error)}</span>
              </p>
            )}
            {done && (
              <p role="status" className="flex items-start gap-2 text-xs text-fg">
                <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
                {t('auth.password.changed')}
              </p>
            )}
            {(
              [
                ['current-password', 'auth.password.currentPassword', current, setCurrent, 'current-password'],
                ['new-password', 'auth.password.newPassword', next, setNext, 'new-password'],
                ['confirm-password', 'auth.register.passwordConfirm', confirm, setConfirm, 'new-password'],
              ] as const
            ).map(([id, label, value, set, autoComplete]) => (
              <div key={id}>
                <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg">
                  {t(label)}
                </label>
                <input
                  id={id}
                  type="password"
                  autoComplete={autoComplete}
                  required
                  maxLength={200}
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  className="input"
                />
                {id === 'new-password' && <p className="mt-1 text-xs text-fg-muted">{t('auth.register.passwordHint')}</p>}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button type="submit" disabled={busy || !current || !next || !confirm} className="btn-primary h-8 text-xs">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('auth.password.changeSubmit')}
              </button>
              <Link href="/forgot-password" className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                {t('auth.login.forgotPassword')}
              </Link>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
