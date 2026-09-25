'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { GoogleMark } from '@/components/auth/GoogleMark';

/** Every code the OAuth callback can send back as ?oauth=... - see lib/auth/oauth/http.ts. */
const OAUTH_OUTCOMES = new Set([
  'cancelled', 'expired', 'failed', 'unavailable', 'link_required',
  'identity_in_use', 'provider_already_linked', 'rate_limited', 'signup_expired', 'account_deleted',
]);
const PROVIDER_LABELS: Record<string, string> = { google: 'Google' };

/**
 * A social sign-in that needs a code delivers its ticket in an httpOnly
 * cookie (the page cannot and should not read it); this marks that mode.
 */
const COOKIE_TICKET = 'cookie';

export function LoginForm({ providers = [] }: { providers?: string[] }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const oauthOutcome = params.get('oauth');
  const oauthProvider = PROVIDER_LABELS[params.get('provider') ?? ''] ?? '';
  const [error, setError] = useState<string | null>(
    // The middleware redirects a banned or expired session here with a reason,
    // so the user is told why they landed on a login screen instead of being
    // silently bounced. A provider callback does the same with ?oauth=.
    params.get('reason') === 'suspended'
      ? 'auth.errors.accountLocked'
      : oauthOutcome && OAUTH_OUTCOMES.has(oauthOutcome)
        ? `auth.oauth.errors.${oauthOutcome}`
        : null,
  );
  const [submitting, setSubmitting] = useState(false);

  /**
   * Second step, for accounts with two-factor authentication. The ticket is
   * held in memory only - never storage, never the URL - and is useless
   * without the code anyway. Reloading the page drops it, which is correct:
   * the password has to be proven again.
   */
  const [ticket, setTicket] = useState<string | null>(params.get('mfa') === '1' ? COOKIE_TICKET : null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');

  /**
   * Where to go after a successful sign-in. Two sources, in priority order.
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
  function finish(payload: { next?: { href?: unknown }; recoveryCodesRemaining?: unknown }) {
    const samePath = (value: unknown): value is string =>
      typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');

    const requested = params.get('next');
    const suggested = payload?.next?.href;

    toast.success(t('auth.login.welcomeBack'));
    // Signed in with a recovery code and running low: say so now, while the
    // person still has a way to act on it.
    if (typeof payload.recoveryCodesRemaining === 'number' && payload.recoveryCodesRemaining <= 3) {
      toast.warning(t('auth.mfa.recoveryLow', { count: payload.recoveryCodesRemaining }));
    }
    router.push(samePath(requested) ? requested : samePath(suggested) ? suggested : '/dashboard');
    router.refresh();
  }

  function backToPassword(message: string | null) {
    setTicket(null);
    setCode('');
    setUseRecovery(false);
    setPassword('');
    setError(message);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sent as typed: the server decides email vs @handle and normalises
        // both, so there is exactly one place that rule can be wrong.
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      });

      const payload = await res.json().catch(() => ({}));
      if (res.ok && payload?.mfaRequired && typeof payload.ticket === 'string') {
        // The password is no longer needed in memory once it has been accepted.
        setPassword('');
        setTicket(payload.ticket);
        return;
      }
      if (res.ok) {
        finish(payload);
        return;
      }
      setError(payload.error ?? 'auth.errors.invalidCredentials');
    } catch {
      setError('errors.network');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || !ticket) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // In cookie mode the server reads the ticket itself.
          ...(ticket === COOKIE_TICKET ? {} : { ticket }),
          ...(useRecovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') }),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        finish(payload);
        return;
      }

      const key: string = payload.error ?? 'auth.errors.mfaInvalid';
      // A wrong code keeps the ticket for another try; anything else means the
      // ticket is spent and the password must be entered again.
      if (key === 'auth.errors.mfaInvalid') {
        setCode('');
        setError(key);
      } else {
        backToPassword(key);
      }
    } catch {
      setError('errors.network');
    } finally {
      setSubmitting(false);
    }
  }

  if (ticket) {
    return (
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-1">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('auth.mfa.title')}</h1>
        <p className="mt-1.5 text-sm text-fg-muted">
          {t(useRecovery ? 'auth.mfa.recoveryPrompt' : 'auth.mfa.prompt')}
        </p>

        <form method="post" onSubmit={submitCode} className="mt-7 space-y-4" noValidate>
          {error && (
            <p role="alert" className="alert-danger">
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t(error)}</span>
            </p>
          )}

          <div>
            <label htmlFor="mfa-code" className="mb-1.5 block text-sm font-medium text-fg">
              {t(useRecovery ? 'auth.mfa.recoveryLabel' : 'auth.mfa.codeLabel')}
            </label>
            {/*
              one-time-code lets iOS/Android offer the code from the
              authenticator; numeric inputMode brings up the digit keypad.
              A recovery code has letters too, so it gets a plain text field.
            */}
            <input
              key={useRecovery ? 'recovery' : 'totp'}
              id="mfa-code"
              type="text"
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete={useRecovery ? 'off' : 'one-time-code'}
              autoCapitalize={useRecovery ? 'characters' : 'none'}
              autoCorrect="off"
              spellCheck={false}
              maxLength={useRecovery ? 24 : 9}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="input font-mono tracking-widest"
            />
          </div>

          <button type="submit" disabled={submitting || code.trim() === ''} className="btn-primary w-full py-2.5">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t('auth.mfa.verify')}
          </button>
        </form>

        <div className="mt-6 flex flex-col items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              setError(null);
            }}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            {t(useRecovery ? 'auth.mfa.useCode' : 'auth.mfa.useRecovery')}
          </button>
          <button
            type="button"
            onClick={() => backToPassword(null)}
            className="text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
          >
            {t('auth.mfa.back')}
          </button>
        </div>
      </div>
    );
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
            <span className="min-w-0">{t(error, { provider: oauthProvider, until: params.get('until') ?? '' })}</span>
          </p>
        )}

        <div>
          <label htmlFor="identifier" className="mb-1.5 block text-sm font-medium text-fg">
            {t('auth.login.identifier')}
          </label>
          {/*
            type="text", not "email": the browser's email validation would
            reject a handle. autoComplete="username" is the token password
            managers pair with current-password, and it covers emails too.
          */}
          <input
            id="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
            maxLength={254}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="input"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <label htmlFor="password" className="text-sm font-medium text-fg">
              {t('auth.login.password')}
            </label>
            <Link
              href="/forgot-password"
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

      {providers.length > 0 && (
        <>
          <div className="my-6 flex items-center gap-3 text-2xs uppercase tracking-wide text-fg-subtle">
            <span className="h-px flex-1 bg-edge" aria-hidden="true" />
            {t('auth.oauth.or')}
            <span className="h-px flex-1 bg-edge" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            {providers.map((provider) => {
              // Plain navigation, not fetch: the flow leaves this site for the
              // provider and comes back through the callback.
              const next = params.get('next');
              const returnTo = next && next.startsWith('/') && !next.startsWith('//') ? `?returnTo=${encodeURIComponent(next)}` : '';
              return (
                <a
                  key={provider}
                  href={`/api/auth/oauth/${provider}/start${returnTo}`}
                  className="btn-secondary w-full justify-center gap-2.5 py-2.5"
                >
                  {provider === 'google' && <GoogleMark />}
                  {t('auth.oauth.continueWith', { provider: PROVIDER_LABELS[provider] ?? provider })}
                </a>
              );
            })}
          </div>
        </>
      )}

      <p className="mt-6 text-center text-sm text-fg-muted">
        {t('auth.login.noAccount')}{' '}
        <Link href="/register" className="font-medium text-accent underline-offset-2 hover:underline">
          {t('nav.register')}
        </Link>
      </p>

      <p className="mt-8 flex items-center justify-center gap-3 text-2xs text-fg-subtle">
        <Link href="/legal/terms" className="transition-colors hover:text-fg">
          {t('landing.footer.terms')}
        </Link>
        <span aria-hidden="true">·</span>
        <Link href="/legal/privacy" className="transition-colors hover:text-fg">
          {t('landing.footer.privacy')}
        </Link>
      </p>
    </div>
  );
}
