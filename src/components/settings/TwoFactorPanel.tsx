'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Check, ChevronLeft, Copy, Download, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';

type Status = {
  enrolled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  sessionVerified: boolean;
  locked: boolean;
};

type Setup = { qrCode: string; manualEntryKey: string; replacing: boolean };

/** Which action a step-up form is guarding. */
type StepUpAction = 'verify' | 'replace' | 'regenerate' | 'disable';

type View =
  | { kind: 'status' }
  | { kind: 'stepUp'; action: StepUpAction }
  | { kind: 'setup'; setup: Setup }
  | { kind: 'codes'; codes: string[]; next: string | null };

/**
 * Settings → Security: the authenticator app and recovery codes.
 *
 * Secrets pass through here exactly once - the QR code and setup key on
 * setup, the recovery codes after confirmation - and live only in component
 * state. They are never written to storage, and leaving the page discards
 * them; the server will not show them again.
 */
export function TwoFactorPanel() {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();

  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<View>({ kind: 'status' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch('/api/auth/mfa', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as Status);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, body: unknown) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    return { ok: res.ok, payload };
  }

  async function startSetup(factor?: FactorBody) {
    setBusy(true);
    setError(null);
    try {
      const { ok, payload } = await post('/api/auth/mfa/totp/setup', factor ?? {});
      if (!ok) return setError(payload.error ?? 'errors.generic');
      setView({ kind: 'setup', setup: payload as Setup });
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(code: string) {
    setBusy(true);
    setError(null);
    try {
      const { ok, payload } = await post('/api/auth/mfa/totp/confirm', { code: code.replace(/\s/g, '') });
      if (!ok) {
        // An expired setup cannot be confirmed any more; send them back.
        if (payload.error === 'auth.errors.mfaSetupExpired') setView({ kind: 'status' });
        return setError(payload.error ?? 'errors.generic');
      }
      toast.success(t('settings.security.enabledToast'));
      setView({ kind: 'codes', codes: payload.recoveryCodes, next: payload.next?.href ?? null });
      void load();
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  async function runStepUp(action: StepUpAction, factor: FactorBody) {
    if (action === 'replace') return startSetup(factor);

    setBusy(true);
    setError(null);
    try {
      const path =
        action === 'verify'
          ? '/api/auth/mfa/step-up'
          : action === 'regenerate'
            ? '/api/auth/mfa/recovery-codes'
            : '/api/auth/mfa/disable';
      const { ok, payload } = await post(path, factor);
      if (!ok) return setError(payload.error ?? 'errors.generic');

      if (action === 'regenerate') {
        setView({ kind: 'codes', codes: payload.recoveryCodes, next: null });
      } else {
        toast.success(t(action === 'verify' ? 'settings.security.verifiedToast' : 'settings.security.disabledToast'));
        setView({ kind: 'status' });
        // A verified staff session has its role back; let the server pages
        // re-render with it before sending them to the panel.
        if (action === 'verify' && typeof payload.next?.href === 'string') {
          router.push(payload.next.href);
          router.refresh();
        }
      }
      void load();
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="mb-6">
      <Link href="/settings" className="btn-ghost -ml-2 h-8 text-xs">
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('settings.security.back')}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-fg">{t('settings.security.title')}</h1>
    </div>
  );

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-8">
        {header}
        <p role="alert" className="alert-danger">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t('settings.security.loadFailed')}</span>
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-16">
        <Loader2 className="h-5 w-5 animate-spin text-fg-subtle" aria-hidden="true" />
      </div>
    );
  }

  const mustEnroll = status.required && !status.enrolled;
  const mustVerify = status.required && status.enrolled && !status.sessionVerified;
  const arrivedRequired = params.get('mfa') === 'required';

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8">
      {header}

      <section className="card p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-md font-medium tracking-tight text-fg">{t('settings.security.heading')}</h2>
            <p className="mt-1 text-xs text-fg-muted">{t('settings.security.description')}</p>
          </div>
          <span
            className={`badge shrink-0 ${
              status.enrolled
                ? 'border-verified/30 bg-verified-soft text-verified-fg'
                : 'border-edge bg-surface-muted text-fg-muted'
            }`}
          >
            {status.enrolled && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
            {t(status.enrolled ? 'settings.security.statusOn' : 'settings.security.statusOff')}
          </span>
        </div>

        {(mustEnroll || mustVerify) && view.kind === 'status' && (
          <p
            // Announced when the admin layout sent them here, so the redirect
            // is explained rather than looking like a lost page.
            role={arrivedRequired ? 'alert' : undefined}
            className="alert mb-5 border-warn/40 bg-warn-soft text-warn-fg"
          >
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t(mustEnroll ? 'settings.security.requiredNotice' : 'settings.security.verifyNotice')}</span>
          </p>
        )}

        {error && (
          <p role="alert" className="alert-danger mb-5">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t(error)}</span>
          </p>
        )}

        {view.kind === 'status' && !status.enrolled && (
          <>
            <p className="text-sm text-fg-muted">{t('settings.security.offBody')}</p>
            <button type="button" disabled={busy} onClick={() => startSetup()} className="btn-primary mt-5 h-9 text-sm">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
              {t('settings.security.enable')}
            </button>
          </>
        )}

        {view.kind === 'status' && status.enrolled && (
          <>
            <dl className="space-y-1 text-sm text-fg-muted">
              {status.enrolledAt && (
                <div>
                  {t('settings.security.enabledSince', {
                    date: new Date(status.enrolledAt).toLocaleDateString(locale, { dateStyle: 'medium' }),
                  })}
                </div>
              )}
              <div className={status.recoveryCodesRemaining <= 3 ? 'font-medium text-warn-fg' : undefined}>
                {t('settings.security.codesRemaining', { count: status.recoveryCodesRemaining })}
              </div>
            </dl>
            <div className="mt-5 flex flex-wrap gap-2">
              {mustVerify && (
                <button type="button" onClick={() => { setError(null); setView({ kind: 'stepUp', action: 'verify' }); }} className="btn-primary h-8 text-xs">
                  {t('settings.security.verifySession')}
                </button>
              )}
              <button type="button" onClick={() => { setError(null); setView({ kind: 'stepUp', action: 'replace' }); }} className="btn-secondary h-8 text-xs">
                {t('settings.security.replace')}
              </button>
              <button type="button" onClick={() => { setError(null); setView({ kind: 'stepUp', action: 'regenerate' }); }} className="btn-secondary h-8 text-xs">
                {t('settings.security.regenerate')}
              </button>
              {!status.required && (
                <button
                  type="button"
                  onClick={() => { setError(null); setView({ kind: 'stepUp', action: 'disable' }); }}
                  className="btn-secondary h-8 border-danger/40 text-xs text-danger-fg"
                >
                  {t('settings.security.disable')}
                </button>
              )}
            </div>
            {status.required && <p className="mt-3 text-xs text-fg-subtle">{t('settings.security.staffCannotDisable')}</p>}
          </>
        )}

        {view.kind === 'stepUp' && (
          <StepUpForm
            busy={busy}
            onSubmit={(factor) => runStepUp(view.action, factor)}
            onCancel={() => { setError(null); setView({ kind: 'status' }); }}
          />
        )}

        {view.kind === 'setup' && (
          <SetupForm
            setup={view.setup}
            busy={busy}
            onConfirm={confirmSetup}
            onCancel={() => { setError(null); setView({ kind: 'status' }); }}
          />
        )}

        {view.kind === 'codes' && (
          <RecoveryCodes
            codes={view.codes}
            onDone={() => {
              setView({ kind: 'status' });
              if (view.next) {
                router.push(view.next);
                router.refresh();
              }
            }}
          />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

type FactorBody = { code: string } | { recoveryCode: string };

function CodeInput({
  id,
  recovery,
  value,
  onChange,
}: {
  id: string;
  recovery: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      key={recovery ? 'recovery' : 'totp'}
      id={id}
      type="text"
      inputMode={recovery ? 'text' : 'numeric'}
      autoComplete={recovery ? 'off' : 'one-time-code'}
      autoCapitalize={recovery ? 'characters' : 'none'}
      autoCorrect="off"
      spellCheck={false}
      maxLength={recovery ? 24 : 9}
      required
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="input max-w-xs font-mono tracking-widest"
    />
  );
}

function StepUpForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (factor: FactorBody) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !value.trim()) return;
        onSubmit(recovery ? { recoveryCode: value.trim() } : { code: value.replace(/\s/g, '') });
        setValue('');
      }}
      className="space-y-4"
    >
      <div>
        <h3 className="text-sm font-medium text-fg">{t('settings.security.stepUpTitle')}</h3>
        <p className="mt-1 text-xs text-fg-muted">{t('settings.security.stepUpPrompt')}</p>
      </div>
      <div>
        <label htmlFor="step-up-code" className="mb-1.5 block text-sm font-medium text-fg">
          {t(recovery ? 'auth.mfa.recoveryLabel' : 'auth.mfa.codeLabel')}
        </label>
        <CodeInput id="step-up-code" recovery={recovery} value={value} onChange={setValue} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !value.trim()} className="btn-primary h-8 text-xs">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {t('settings.security.continue')}
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost h-8 text-xs">
          {t('settings.security.cancel')}
        </button>
        <button
          type="button"
          onClick={() => { setRecovery((v) => !v); setValue(''); }}
          className="ml-auto text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          {t(recovery ? 'auth.mfa.useCode' : 'auth.mfa.useRecovery')}
        </button>
      </div>
    </form>
  );
}

function SetupForm({
  setup,
  busy,
  onConfirm,
  onCancel,
}: {
  setup: Setup;
  busy: boolean;
  onConfirm: (code: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-fg">{t('settings.security.scanTitle')}</h3>
        <p className="mt-1 text-xs text-fg-muted">{t('settings.security.scanHint')}</p>
      </div>
      {/* White tile in both themes: scanners need dark-on-light contrast. */}
      <div className="inline-block rounded-lg border border-edge bg-white p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimise */}
        <img src={setup.qrCode} alt={t('settings.security.qrAlt')} width={184} height={184} />
      </div>
      <div>
        <div className="text-xs font-medium text-fg-muted">{t('settings.security.manualKey')}</div>
        <code className="mt-1 block select-all break-all font-mono text-sm text-fg">{setup.manualEntryKey}</code>
      </div>
      <form
        method="post"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || !code.trim()) return;
          onConfirm(code);
          setCode('');
        }}
        className="space-y-3"
      >
        <label htmlFor="setup-code" className="block text-sm font-medium text-fg">
          {t('settings.security.confirmLabel')}
        </label>
        <CodeInput id="setup-code" recovery={false} value={code} onChange={setCode} />
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !code.trim()} className="btn-primary h-8 text-xs">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {t('settings.security.confirm')}
          </button>
          <button type="button" onClick={onCancel} className="btn-ghost h-8 text-xs">
            {t('settings.security.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-fg">{t('settings.security.codesTitle')}</h3>
        <p className="mt-1 text-xs text-fg-muted">{t('settings.security.codesHint')}</p>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 rounded-lg border border-edge bg-surface-muted p-4 font-mono text-sm text-fg sm:grid-cols-2">
        {codes.map((c) => (
          <li key={c} className="select-all">{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              /* clipboard blocked: the codes are selectable on screen */
            }
          }}
          className="btn-secondary h-8 text-xs"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {t(copied ? 'settings.security.copied' : 'settings.security.copy')}
        </button>
        <button
          type="button"
          onClick={() => {
            // Built in memory and revoked straight after: no server round
            // trip, so the codes are never requested again.
            const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'campushub-recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="btn-secondary h-8 text-xs"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {t('settings.security.download')}
        </button>
        <button type="button" onClick={onDone} className="btn-primary h-8 text-xs">
          {t('settings.security.done')}
        </button>
      </div>
    </div>
  );
}
