'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, Link2, Loader2, Unlink } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { GoogleMark } from '@/components/auth/GoogleMark';

type Identity = { provider: string; emailHint: string | null; linkedAt: string; lastUsedAt: string };
type Data = {
  identities: Identity[];
  available: string[];
  hasPassword: boolean;
  reauth: 'code' | 'password' | 'recent_sign_in';
};
type Pending = { action: 'link' | 'unlink'; provider: string } | null;

const LABELS: Record<string, string> = { google: 'Google' };
/** Outcomes a link attempt can come back with - see lib/auth/oauth/http.ts. */
const LINK_OUTCOMES = new Set(['cancelled', 'expired', 'failed', 'identity_in_use', 'provider_already_linked', 'rate_limited']);

/**
 * Settings → Security → Connected accounts.
 *
 * Linking and unlinking both ask for the account's strongest proof first
 * (authenticator code, else password, else a recent sign-in - the server
 * decides and tells us which in `reauth`). Linking then leaves the site for
 * the provider and returns here with ?linked= or ?oauth=.
 */
export function LinkedAccountsPanel() {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const params = useSearchParams();

  const [data, setData] = useState<Data | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);
  const outcome = params.get('oauth');
  const [error, setError] = useState<string | null>(
    outcome && LINK_OUTCOMES.has(outcome) ? `auth.oauth.errors.${outcome}` : null,
  );
  const errorProvider = LABELS[params.get('provider') ?? ''] ?? '';

  const load = useCallback(async () => {
    const res = await fetch('/api/me/identities', { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setData((await res.json()) as Data);
  }, []);

  useEffect(() => {
    void load();
    const linked = params.get('linked');
    if (linked && LABELS[linked]) toast.success(t('auth.oauth.linkedToast', { provider: LABELS[linked] }));
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data || data.available.length === 0) return null;

  const linked = new Map(data.identities.map((i) => [i.provider, i]));
  const methods = data.identities.length + (data.hasPassword ? 1 : 0);

  async function run(target: NonNullable<Pending>) {
    setBusy(true);
    setError(null);
    const body =
      data!.reauth === 'code'
        ? { code: proof.replace(/\s/g, '') }
        : data!.reauth === 'password'
          ? { password: proof }
          : {};
    try {
      const res = await fetch(
        target.action === 'link' ? `/api/auth/oauth/${target.provider}/link` : `/api/me/identities/${target.provider}`,
        {
          method: target.action === 'link' ? 'POST' : 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) return setError(payload.error ?? 'errors.generic');

      if (target.action === 'link' && typeof payload.url === 'string') {
        // Off to the provider; the callback brings the browser back here.
        window.location.assign(payload.url);
        return;
      }
      toast.success(t('auth.oauth.unlinkedToast', { provider: LABELS[target.provider] }));
      setPending(null);
      setProof('');
      void load();
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-10">
      <section className="card p-6">
        <h2 className="text-md font-medium tracking-tight text-fg">{t('auth.oauth.connectedTitle')}</h2>
        <p className="mt-1 text-xs text-fg-muted">{t('auth.oauth.connectedDescription')}</p>

        {error && (
          <p role="alert" className="alert-danger mt-4">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(error, { provider: errorProvider })}</span>
          </p>
        )}

        <ul className="mt-4 divide-y divide-edge">
          {data.available.map((provider) => {
            const identity = linked.get(provider);
            // The last way in cannot be removed (the server refuses too).
            const lastMethod = !!identity && methods <= 1;
            return (
              <li key={provider} className="flex items-center gap-3 py-3">
                {provider === 'google' && <GoogleMark className="h-5 w-5 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg">{LABELS[provider]}</div>
                  <div className="text-xs text-fg-muted">
                    {identity
                      ? t('auth.oauth.linkedSince', {
                          account: identity.emailHint ?? LABELS[provider],
                          date: new Date(identity.linkedAt).toLocaleDateString(locale, { dateStyle: 'medium' }),
                        })
                      : t('auth.oauth.notLinked')}
                  </div>
                </div>
                {identity ? (
                  <button
                    type="button"
                    disabled={lastMethod}
                    title={lastMethod ? t('auth.oauth.errors.last_method') : undefined}
                    onClick={() => { setError(null); setProof(''); setPending({ action: 'unlink', provider }); }}
                    className="btn-secondary h-8 text-xs disabled:opacity-50"
                  >
                    <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('auth.oauth.unlink')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setError(null); setProof(''); setPending({ action: 'link', provider }); }}
                    className="btn-secondary h-8 text-xs"
                  >
                    <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('auth.oauth.link')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {pending && (
          <form
            method="post"
            noValidate
            className="mt-4 space-y-3 rounded-lg border border-edge p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void run(pending);
            }}
          >
            <p className="text-sm text-fg">
              {t(pending.action === 'link' ? 'auth.oauth.confirmLink' : 'auth.oauth.confirmUnlink', {
                provider: LABELS[pending.provider],
              })}
            </p>
            {data.reauth === 'recent_sign_in' ? (
              <p className="text-xs text-fg-muted">{t('auth.reauth.recentHint')}</p>
            ) : (
              <div>
                <label htmlFor="link-proof" className="mb-1.5 block text-xs font-medium text-fg">
                  {t(data.reauth === 'code' ? 'auth.mfa.codeLabel' : 'auth.reauth.passwordLabel')}
                </label>
                <input
                  id="link-proof"
                  type={data.reauth === 'code' ? 'text' : 'password'}
                  inputMode={data.reauth === 'code' ? 'numeric' : undefined}
                  autoComplete={data.reauth === 'code' ? 'one-time-code' : 'current-password'}
                  autoFocus
                  value={proof}
                  onChange={(e) => setProof(e.target.value)}
                  className="input max-w-xs text-sm"
                />
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy || (data.reauth !== 'recent_sign_in' && !proof)}
                className="btn-primary h-8 text-xs"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('settings.security.continue')}
              </button>
              <button type="button" onClick={() => setPending(null)} className="btn-ghost h-8 text-xs">
                {t('settings.security.cancel')}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
