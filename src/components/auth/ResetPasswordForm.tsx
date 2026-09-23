'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { useT } from '@/lib/i18n/LocaleProvider';

const STORAGE_KEY = 'ch_reset_token';

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function store(token: string | null) {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked: a reload just means opening the link again */
  }
}

type State = 'form' | 'done' | 'invalid';

/**
 * /reset-password#token=...
 *
 * The token is in the FRAGMENT, so it never reached a server. It is taken out
 * of the address bar at once (history, screenshots, a shared screen) and kept
 * in sessionStorage - this tab only, gone when it closes - so a reload does
 * not lose it. It is cleared the moment the server says it is used or dead.
 */
export function ResetPasswordForm() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<State>('form');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (fromHash) {
      store(fromHash);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const found = fromHash ?? readStored();
    if (found) setToken(found);
    else setState('invalid');
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) return setError('auth.errors.passwordMismatch');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        store(null);
        setState('done');
        return;
      }
      if (body.error === 'auth.password.errors.linkInvalid') {
        store(null);
        setState('invalid');
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
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('auth.password.resetTitle')}</h1>

      {state === 'done' && (
        <>
          <p role="status" className="mt-4 flex items-start gap-2 text-sm text-fg">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
            {t('auth.password.resetDone')}
          </p>
          <Link href="/login" className="btn-primary mt-6 inline-flex h-9 text-sm">
            {t('auth.password.toLogin')}
          </Link>
        </>
      )}

      {state === 'invalid' && (
        <>
          <p role="alert" className="alert-danger mt-4">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t('auth.password.errors.linkInvalid')}</span>
          </p>
          <Link href="/forgot-password" className="btn-secondary mt-6 inline-flex h-9 text-sm">
            {t('auth.password.requestNew')}
          </Link>
        </>
      )}

      {state === 'form' && (
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
          <button
            type="submit"
            disabled={busy || !token || password === '' || confirm === ''}
            className="btn-primary w-full py-2.5"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t('auth.password.save')}
          </button>
        </form>
      )}
    </div>
  );
}
