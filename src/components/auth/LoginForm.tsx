'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useT } from '@/lib/i18n/LocaleProvider';

export function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(
    // The middleware redirects a banned or expired session here with a reason,
    // so the user is told why they landed on a login screen instead of being
    // silently bounced.
    params.get('reason') === 'suspended' ? 'auth.errors.accountLocked' : null,
  );
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });

      if (res.ok) {
        const payload = await res.json().catch(() => ({}));

        /**
         * Two sources, in priority order.
         *
         * 1. An explicit `?next=` - someone who was bounced to the login screen
         *    from a page should land back on that page.
         * 2. Otherwise the destination the SERVER chose from the live role.
         *    This is the fix for staff being dropped on the student feed: the
         *    client cannot read a role (the access token carries none by
         *    design), so it previously had nothing to branch on and hardcoded
         *    /dashboard for everyone.
         *
         * Both are validated as same-origin paths before use. An open redirect
         * here would let a phishing link bounce through our own domain, and
         * that check has to apply to the server's value too - it arrives over
         * the network like any other response body.
         */
        const samePath = (value: unknown): value is string =>
          typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');

        const requested = params.get('next');
        const suggested = payload?.next?.href;

        router.push(
          samePath(requested) ? requested : samePath(suggested) ? suggested : '/dashboard',
        );
        router.refresh();
        return;
      }

      const payload = await res.json().catch(() => ({}));
      setError(payload.error ?? 'auth.errors.invalidCredentials');
    } catch {
      setError('errors.network');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>

      <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('auth.login.title')}</h1>
      <p className="mt-1.5 text-sm text-fg-muted">{t('auth.register.subtitle')}</p>

      {/*
        Same pre-hydration guard as the register wizard. These inputs carry no
        name= attribute, so a native GET would currently serialise nothing -
        but that is an accident of markup, one added name= away from leaking a
        password into the URL. method="post" makes the safety structural
        instead of incidental.
      */}
      <form method="post" onSubmit={submit} className="mt-7 space-y-4" noValidate>
        {error && (
          <p role="alert" className="alert-danger">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(error)}</span>
          </p>
        )}

        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-fg">
            {t('auth.login.email')}
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <label htmlFor="password" className="text-sm font-medium text-fg">
              {t('auth.login.password')}
            </label>
            <Link
              href="/help"
              className="text-xs text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
            >
              {t('auth.login.forgotPassword')}
            </Link>
          </div>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t('auth.register.hidePassword') : t('auth.register.showPassword')}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-fg-subtle
 transition-colors hover:text-fg"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5">
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('auth.login.submit')}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-fg-muted">
        {t('auth.login.noAccount')}{' '}
        <Link href="/register" className="font-medium text-accent underline-offset-2 hover:underline">
          {t('nav.register')}
        </Link>
      </p>
    </div>
  );
}
