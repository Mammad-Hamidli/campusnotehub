'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2, QrCode } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type Reauth = 'code' | 'password' | 'recent_sign_in';
type Device = { browser: string | null; os: string | null; mobile: boolean };
type View =
  | { step: 'closed' }
  | { step: 'proof' }
  | { step: 'showing'; id: string; qr: string; deadline: number }
  | { step: 'linked'; device: Device }
  | { step: 'expired' };

const POLL_MS = 2000;

/**
 * Settings -> Account -> Devices -> "Sign in on another device".
 *
 * Proves it is still the owner (password or authenticator code, like any
 * sensitive change), shows a two-minute single-use QR code, and polls until
 * the other device has used it. Scanning opens /link-device there, which asks
 * one confirming tap and signs in - no password typed on the new device.
 *
 * A code on screen is a live credential, so it is withdrawn the moment it is
 * not needed: Cancel, closing the settings page, or a new code replacing it.
 */
export function LinkDeviceCard({ onLinked }: { onLinked: () => void }) {
  const t = useT();
  const [view, setView] = useState<View>({ step: 'closed' });
  const [reauth, setReauth] = useState<Reauth | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const activeId = useRef<string | null>(null);

  const withdraw = useCallback(() => {
    const id = activeId.current;
    activeId.current = null;
    if (id) void fetch(`/api/me/device-links/${id}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
  }, []);

  useEffect(() => withdraw, [withdraw]);

  async function start() {
    withdraw();
    setView({ step: 'proof' });
    setError(null);
    setSecret('');
    if (reauth) return;
    try {
      const res = await fetch('/api/me/device-links', { cache: 'no-store' });
      setReauth(((await res.json().catch(() => ({}))) as { reauth?: Reauth }).reauth ?? 'password');
    } catch {
      setReauth('password');
    }
  }

  function close() {
    withdraw();
    setView({ step: 'closed' });
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const proof =
      reauth === 'code' ? { code: secret.replace(/\s/g, '') } : reauth === 'password' ? { password: secret } : {};
    try {
      const res = await fetch('/api/me/device-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(proof),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'errors.generic');
        return;
      }
      activeId.current = body.id;
      setSecret('');
      setNow(Date.now());
      setView({ step: 'showing', id: body.id, qr: body.qr, deadline: Date.now() + body.expiresIn * 1000 });
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  const showingId = view.step === 'showing' ? view.id : null;
  useEffect(() => {
    if (!showingId) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/me/device-links/${showingId}`, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (activeId.current !== showingId) return; // closed or replaced meanwhile
        if (body.state === 'linked') {
          activeId.current = null;
          setView({ step: 'linked', device: body.device });
          onLinked();
        } else if (body.state === 'expired' || res.status === 404) {
          activeId.current = null;
          setView({ step: 'expired' });
        }
      } catch {
        // A missed poll is simply retried on the next one.
      }
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [showingId, onLinked]);

  const secondsLeft = view.step === 'showing' ? Math.max(0, Math.ceil((view.deadline - now) / 1000)) : 0;
  const deviceName = (device: Device) =>
    [device.browser, device.os].filter(Boolean).join(' · ') || t('settings.devices.unknown');

  return (
    <div className="mt-4 border-t border-edge pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-fg">{t('settings.devices.link.title')}</h3>
          <p className="mt-0.5 text-xs text-fg-muted">{t('settings.devices.link.description')}</p>
        </div>
        {(view.step === 'closed' || view.step === 'linked') && (
          <button type="button" onClick={() => void start()} className="btn-secondary h-8 shrink-0 text-xs">
            <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
            {t('settings.devices.link.start')}
          </button>
        )}
      </div>

      {view.step === 'proof' && (
        <form onSubmit={generate} className="mt-4 space-y-3">
          {!reauth ? (
            <Loader2 className="h-4 w-4 animate-spin text-fg-subtle" aria-hidden="true" />
          ) : reauth === 'recent_sign_in' ? (
            <p className="text-xs leading-relaxed text-fg-muted">{t('auth.reauth.recentHint')}</p>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-fg">
                {t(reauth === 'code' ? 'auth.mfa.codeLabel' : 'settings.email.currentPassword')}
              </span>
              <input
                type={reauth === 'code' ? 'text' : 'password'}
                inputMode={reauth === 'code' ? 'numeric' : undefined}
                autoComplete={reauth === 'code' ? 'one-time-code' : 'current-password'}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                className="input max-w-xs py-1.5 text-sm"
                autoFocus
              />
              <span className="mt-1 block text-2xs text-fg-subtle">{t('settings.devices.link.proofHint')}</span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {t(error)}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !reauth || (reauth !== 'recent_sign_in' && !secret)}
              className="btn-primary h-8 text-xs"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('settings.devices.link.generate')}
            </button>
            <button type="button" onClick={close} className="btn-ghost h-8 text-xs">
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {view.step === 'showing' && (
        <div className="mt-4 flex flex-wrap items-center gap-5">
          {/* White behind the code in both themes: scanners need the contrast. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, no loader */}
          <img
            src={view.qr}
            alt={t('settings.devices.link.qrAlt')}
            className="h-48 w-48 rounded-lg bg-white p-2"
          />
          <div className="min-w-0 flex-1 basis-48 space-y-3">
            <p className="text-sm text-fg">{t('settings.devices.link.scan')}</p>
            <p className="text-xs tabular-nums text-fg-muted" aria-live="off">
              {t('settings.devices.link.expiresIn', {
                time: `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`,
              })}
            </p>
            <p className="flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('settings.devices.link.waiting')}
            </p>
            <button type="button" onClick={close} className="btn-ghost h-8 text-xs">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {view.step === 'linked' && (
        <p role="status" className="mt-4 flex items-start gap-2 text-sm text-fg">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
          {t('settings.devices.link.linked', { device: deviceName(view.device) })}
        </p>
      )}

      {view.step === 'expired' && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-muted">{t('settings.devices.link.expired')}</p>
          <button type="button" onClick={() => void start()} className="btn-secondary h-8 text-xs">
            {t('settings.devices.link.again')}
          </button>
          <button type="button" onClick={close} className="btn-ghost h-8 text-xs">
            {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
