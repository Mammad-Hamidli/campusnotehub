'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';

/**
 * The first local password of a Google-only account. No skip button, on
 * purpose: the account is view-only and every page sends it back here until
 * this succeeds. The only other way out is signing out.
 */
export function SetPasswordForm() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < 12 || new Set(password).size < 5) return setError('auth.errors.weakPassword');
    if (password !== confirm) return setError('auth.errors.passwordMismatch');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/password/initial', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => ({}));
      // 409: already set (another tab) - nothing is owed any more either way.
      if (res.ok || res.status === 409) {
        toast.success(t('auth.setPassword.done'));
        router.replace('/dashboard');
        router.refresh();
        return;
      }
      setError(body.error ?? 'errors.generic');
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
      <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand">
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
        {t('auth.setPassword.badge')}
      </span>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-fg">{t('auth.setPassword.title')}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t('auth.setPassword.subtitle')}</p>

      <form method="post" onSubmit={submit} className="mt-7 space-y-4" noValidate>
        {error && (
          <p role="alert" className="alert-danger">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(error)}</span>
          </p>
        )}
        <div>
          <label htmlFor="new-password" className="mb-1.5 block text-sm font-medium text-fg">
            {t('auth.password.newPassword')}
          </label>
          <div className="relative">
            <input
              id="new-password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              required
              autoFocus
              minLength={12}
              maxLength={200}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby="new-password-hint"
              className="input pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? t('auth.register.hidePassword') : t('auth.register.showPassword')}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-fg-subtle transition-colors hover:text-fg"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p id="new-password-hint" className="mt-1.5 text-xs text-fg-muted">
            {t('auth.register.passwordHint')}
          </p>
        </div>
        <div>
          <label htmlFor="confirm-password" className="mb-1.5 block text-sm font-medium text-fg">
            {t('auth.register.passwordConfirm')}
          </label>
          <input
            id="confirm-password"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            required
            maxLength={200}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="input"
          />
        </div>
        <button type="submit" disabled={busy || password === '' || confirm === ''} className="btn-primary w-full py-2.5">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('auth.password.save')}
        </button>
      </form>

      <Link href="/logout" className="mt-6 inline-block text-xs text-fg-muted underline-offset-2 hover:underline">
        {t('auth.setPassword.signOut')}
      </Link>
    </div>
  );
}
