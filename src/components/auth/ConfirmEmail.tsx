'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * The two links that land on a page like this one: confirming the account's
 * address (/confirm-email) and finishing a change of it
 * (/confirm-email-change). Same flow - token from the fragment, redeemed by
 * the signed-in owner - with a different endpoint and wording.
 */
const KINDS = {
  verify: {
    storageKey: 'ch_email_token',
    endpoint: '/api/me/email/verify',
    path: '/confirm-email',
    titleKey: 'auth.emailVerify.pageTitle',
    workingKey: 'auth.emailVerify.working',
    doneKey: 'auth.emailVerify.done',
    fallbackError: 'auth.emailVerify.errors.invalid',
  },
  change: {
    storageKey: 'ch_email_change_token',
    endpoint: '/api/me/email/change/confirm',
    path: '/confirm-email-change',
    titleKey: 'settings.email.confirmTitle',
    workingKey: 'auth.emailVerify.working',
    doneKey: 'settings.email.changed',
    fallbackError: 'settings.email.errors.linkInvalid',
  },
} as const;

function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, token: string | null) {
  try {
    if (token) sessionStorage.setItem(key, token);
    else sessionStorage.removeItem(key);
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
export function ConfirmEmail({ kind = 'verify' }: { kind?: keyof typeof KINDS }) {
  const t = useT();
  const router = useRouter();
  const config = KINDS[kind];
  const [state, setState] = useState<State>('working');
  const [error, setError] = useState<string>(config.fallbackError);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (fromHash) {
      store(config.storageKey, fromHash);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const token = fromHash ?? readStored(config.storageKey);
    if (!token) {
      setState('error');
      return;
    }

    void (async () => {
      try {
        const res = await fetch(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (res.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(config.path)}`);
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          store(config.storageKey, null);
          setState('done');
          return;
        }
        // The wrong account is signed in: keep the token so signing in as the
        // right one and returning here still works.
        if (body.error !== 'auth.emailVerify.errors.wrongAccount') store(config.storageKey, null);
        setError(body.error ?? 'errors.generic');
        setState('error');
      } catch {
        setError('errors.network');
        setState('error');
      }
    })();
  }, [router, config]);

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8">
        <Logo />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{t(config.titleKey)}</h1>

      {state === 'working' && (
        <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted" aria-busy="true">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t(config.workingKey)}
        </p>
      )}

      {state === 'done' && (
        <>
          <p role="status" className="mt-4 flex items-start gap-2 text-sm text-fg">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
            {t(config.doneKey)}
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
