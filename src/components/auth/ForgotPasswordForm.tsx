'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Loader2, MailCheck } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * /forgot-password
 *
 * The confirmation is the same sentence whether or not the address has an
 * account - the API answers identically too (see /api/auth/password/forgot).
 * Only a malformed address or the rate limit produce an error.
 */
export function ForgotPasswordForm() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password/forgot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body.error ?? 'errors.generic');
      setSentTo(email.trim());
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8">
        <Logo />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('auth.password.forgotTitle')}</h1>

      {sentTo ? (
        <>
          <p role="status" className="mt-4 flex items-start gap-2 text-sm text-fg">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
            <span className="min-w-0 break-words">{t('auth.password.sent', { email: sentTo })}</span>
          </p>
          <Link href="/login" className="btn-secondary mt-6 inline-flex h-9 text-sm">
            {t('auth.password.backToLogin')}
          </Link>
        </>
      ) : (
        <>
          <p className="mt-1.5 text-sm text-fg-muted">{t('auth.password.forgotSubtitle')}</p>
          <form method="post" onSubmit={submit} className="mt-7 space-y-4" noValidate>
            {error && (
              <p role="alert" className="alert-danger">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{t(error)}</span>
              </p>
            )}
            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-fg">
                {t('auth.password.emailLabel')}
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                autoFocus
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
              />
            </div>
            <button type="submit" disabled={busy || email.trim() === ''} className="btn-primary w-full py-2.5">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('auth.password.sendLink')}
            </button>
          </form>
          <p className="mt-6 text-center text-sm">
            <Link href="/login" className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">
              {t('auth.password.backToLogin')}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
