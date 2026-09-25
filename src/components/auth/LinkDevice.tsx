'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Loader2, ShieldCheck } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { useT } from '@/lib/i18n/LocaleProvider';

type Account = { nickname: string; fullName: string; avatarUrl: string | null };
type State =
  | { step: 'checking' }
  | { step: 'confirm'; account: Account }
  | { step: 'signingIn'; account: Account }
  | { step: 'error'; message: string };

async function post(token: string, confirm: boolean) {
  const res = await fetch('/api/auth/device-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, confirm }),
  });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

/**
 * /link-device#t=... - the page a QR code from Settings -> Devices opens.
 *
 * The token is in the FRAGMENT, so no server, proxy or link preview ever saw
 * it; it is read here and removed from the address bar at once. The page then
 * asks which account the code belongs to and waits for one tap before
 * consuming it: signing in as somebody else's account because a link said so
 * is the attack this confirmation exists to stop (see the route).
 */
export function LinkDevice() {
  const t = useT();
  const [state, setState] = useState<State>({ step: 'checking' });
  const token = useRef<string | null>(null);

  useEffect(() => {
    if (token.current !== null) return;
    token.current = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
    window.history.replaceState(null, '', window.location.pathname);
    if (!token.current) {
      setState({ step: 'error', message: 'auth.deviceLink.errors.invalid' });
      return;
    }
    void post(token.current, false)
      .then(({ ok, body }) =>
        setState(ok ? { step: 'confirm', account: body.account } : { step: 'error', message: body.error ?? 'errors.generic' }),
      )
      .catch(() => setState({ step: 'error', message: 'errors.network' }));
  }, []);

  async function signIn(account: Account) {
    setState({ step: 'signingIn', account });
    try {
      const { ok, body } = await post(token.current ?? '', true);
      if (!ok) {
        setState({ step: 'error', message: body.error ?? 'errors.generic' });
        return;
      }
      // A full navigation, so the next page renders with the new cookies.
      window.location.assign(body.next?.href ?? '/dashboard');
    } catch {
      setState({ step: 'error', message: 'errors.network' });
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8">
        <Logo />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('auth.deviceLink.title')}</h1>

      {state.step === 'checking' && (
        <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted" aria-busy="true">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('auth.deviceLink.checking')}
        </p>
      )}

      {(state.step === 'confirm' || state.step === 'signingIn') && (
        <>
          <div className="card mt-6 flex items-center gap-3 p-4">
            <UserAvatar nickname={state.account.nickname} src={state.account.avatarUrl} verified={false} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">{state.account.fullName}</p>
              <p className="truncate text-xs text-fg-muted">@{state.account.nickname}</p>
            </div>
          </div>
          <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
            <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            {t('auth.deviceLink.warning')}
          </p>
          <button
            type="button"
            disabled={state.step === 'signingIn'}
            onClick={() => void signIn(state.account)}
            className="btn-primary mt-6 h-10 w-full text-sm"
          >
            {state.step === 'signingIn' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t('auth.deviceLink.continue', { nickname: state.account.nickname })}
          </button>
          <Link href="/login" className="btn-ghost mt-2 h-10 w-full text-sm">
            {t('auth.deviceLink.notMe')}
          </Link>
        </>
      )}

      {state.step === 'error' && (
        <>
          <p role="alert" className="alert-danger mt-4">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(state.message)}</span>
          </p>
          <Link href="/login" className="btn-secondary mt-6 inline-flex h-9 text-sm">
            {t('auth.deviceLink.toLogin')}
          </Link>
        </>
      )}
    </div>
  );
}
