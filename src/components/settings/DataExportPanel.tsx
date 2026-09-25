'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, ChevronLeft, Download, Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';

type Reauth = 'code' | 'password' | 'recent_sign_in';

const INCLUDED = [
  'settings.export.included.account',
  'settings.export.included.security',
  'settings.export.included.content',
  'settings.export.included.social',
  'settings.export.included.notes',
  'settings.export.included.mentoring',
  'settings.export.included.notifications',
  'settings.export.included.verification',
] as const;

/** Falls back to a generic name if the header is missing or unreadable. */
function fileNameFrom(disposition: string | null): string {
  return /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? 'campusnotehub-data.json';
}

/**
 * Settings -> Account -> Download my data.
 *
 * One button that hands over a JSON file of everything the account holds
 * (POST /api/me/export; the contents are defined in src/lib/account/export.ts).
 * The account's strongest factor is asked for first, exactly like filing a
 * deletion request - the file carries email, phone and date of birth, and a
 * signed-in browser is not proof its owner is at it.
 *
 * The file is fetched and saved through a blob rather than by navigating to
 * the endpoint, because the proof travels in a POST body, and a failure then
 * surfaces here as a message instead of as a browser error page.
 */
export function DataExportPanel() {
  const t = useT();
  const toast = useToast();
  const [reauth, setReauth] = useState<Reauth | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me/export', { signal: controller.signal, cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : {}))
      .then((body: { reauth?: Reauth }) => setReauth(body.reauth ?? 'password'))
      .catch((cause) => {
        if ((cause as Error)?.name !== 'AbortError') setReauth('password');
      });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !reauth) return;
    setBusy(true);
    setError(null);
    setDone(false);

    const proof =
      reauth === 'code' ? { code: secret.replace(/\s/g, '') } : reauth === 'password' ? { password: secret } : {};

    try {
      const res = await fetch('/api/me/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(proof),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(payload.error ?? 'errors.generic');
        return;
      }

      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = fileNameFrom(res.headers.get('content-disposition'));
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on the next tick: revoking synchronously can cancel the save.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);

      setSecret('');
      setDone(true);
      toast.success(t('settings.export.started'));
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8">
      <div className="mb-6">
        <Link href="/settings" className="btn-ghost -ml-2 h-8 text-xs">
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('settings.export.back')}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-fg">{t('settings.export.title')}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t('settings.export.intro')}</p>
      </div>

      <section className="card p-6">
        <h2 className="text-md font-medium tracking-tight text-fg">{t('settings.export.includedTitle')}</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-fg-muted marker:text-fg-subtle">
          {INCLUDED.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        <p className="mt-4 rounded-lg bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
          {t('settings.export.excluded')}
        </p>

        {!reauth ? (
          <div className="mt-6 flex justify-center" aria-busy="true">
            <Loader2 className="h-5 w-5 animate-spin text-fg-subtle" aria-hidden="true" />
          </div>
        ) : (
          <form method="post" onSubmit={submit} className="mt-6 space-y-3 border-t border-edge pt-5" noValidate>
            {reauth === 'recent_sign_in' ? (
              // No password and no authenticator: a fresh sign-in through the
              // provider is the proof, and the server checks it.
              <p className="text-xs leading-relaxed text-fg-muted">{t('auth.reauth.recentHint')}</p>
            ) : (
              <div>
                <p className="mb-2 text-xs leading-relaxed text-fg-muted">{t('settings.export.confirmHint')}</p>
                <label htmlFor="export-secret" className="mb-1 block text-xs font-medium text-fg">
                  {t(reauth === 'code' ? 'auth.mfa.codeLabel' : 'auth.reauth.passwordLabel')}
                </label>
                <input
                  id="export-secret"
                  type={reauth === 'code' ? 'text' : 'password'}
                  inputMode={reauth === 'code' ? 'numeric' : undefined}
                  autoComplete={reauth === 'code' ? 'one-time-code' : 'current-password'}
                  required
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  aria-invalid={error === 'auth.errors.reauthFailed' || error === 'auth.errors.mfaInvalid'}
                  className="input text-sm"
                />
              </div>
            )}

            {error && (
              <p role="alert" className="alert-danger">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{t(error)}</span>
              </p>
            )}
            {done && (
              <p role="status" className="flex items-start gap-2 text-xs text-fg">
                <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
                {t('settings.export.done')}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || (reauth !== 'recent_sign_in' && secret.length === 0)}
              className="btn-primary h-9 px-4 text-sm disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-4 w-4" aria-hidden="true" />
              )}
              {t(busy ? 'settings.export.preparing' : 'settings.export.submit')}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
