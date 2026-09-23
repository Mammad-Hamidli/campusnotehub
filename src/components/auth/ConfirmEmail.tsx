'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { useT } from '@/lib/i18n/LocaleProvider';

const STORAGE_KEY = 'ch_email_token';

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
    /* storage blocked: the person just opens the link again after signing in */
  }
}

type State = 'working' | 'done' | 'error';

/**
 * /confirm-email#token=...
 *
 * The token is in the FRAGMENT, so it never reached any server. It is read
 * here, removed from the address bar at once (so it is not left in history or
 * a screenshot), and POSTed with the session.
 *
 * Signed out: the token waits in sessionStorage - this tab only, gone when it
 * closes - while the person signs in, and the login page brings them back
 * here to finish. Verification only ever completes in a session of the
 * account the link was sent for; see repositories/emailVerification.ts.
 */
export function ConfirmEmail() {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<State>('working');
  const [error, setError] = useState<string>('auth.emailVerify.errors.invalid');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (fromHash) {
      store(fromHash);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const token = fromHash ?? readStored();
    if (!token) {
      setState('error');
      return;
    }

    void (async () => {
      try {
        const res = await fetch('/api/me/email/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (res.status === 401) {
          router.replace(`/login?next=${encodeURIComponent('/confirm-email')}`);
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          store(null);
          setState('done');
          return;
        }
        // The wrong account is signed in: keep the token so signing in as the
        // right one and returning here still works.
        if (body.error !== 'auth.emailVerify.errors.wrongAccount') store(null);
        setError(body.error ?? 'errors.generic');
        setState('error');
      } catch {
        setError('errors.network');
        setState('error');
      }
    })();
  }, [router]);

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8">
        <Logo />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('auth.emailVerify.pageTitle')}</h1>

      {state === 'working' && (
        <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted" aria-busy="true">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('auth.emailVerify.working')}
        </p>
      )}

      {state === 'done' && (
        <>
          <p role="status" className="mt-4 flex items-start gap-2 text-sm text-fg">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
            {t('auth.emailVerify.done')}
          </p>
          <Link href="/settings/security" className="btn-primary mt-6 inline-flex h-9 text-sm">
            {t('auth.emailVerify.toSettings')}
          </Link>
        </>
      )}

      {state === 'error' && (
        <>
          <p role="alert" className="alert-danger mt-4">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(error)}</span>
          </p>
          <Link href="/settings/security" className="btn-secondary mt-6 inline-flex h-9 text-sm">
            {t('auth.emailVerify.requestNew')}
          </Link>
        </>
      )}
    </div>
  );
}
