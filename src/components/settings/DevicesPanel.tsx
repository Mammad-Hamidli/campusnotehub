'use client';

import { useCallback, useEffect, useState } from 'react';
import { Laptop, Loader2, LogOut, Smartphone } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { LinkDeviceCard } from './LinkDeviceCard';

type Device = {
  id: string;
  current: boolean;
  /** Live sessions this device holds; the server folds them into one row. */
  sessionCount: number;
  device: { browser: string | null; os: string | null; mobile: boolean };
  signedInAt: string;
  lastActiveAt: string;
};

/**
 * Settings → Account → Devices: every browser signed in to this account, when
 * it signed in and when it was last used, with "This device" marked. One row
 * per device: a browser that signed in more than once shows once, with a
 * "N sessions" badge. Any other device can be signed out on the spot (DELETE
 * /api/me/sessions/:id signs out all of its sessions) - the next request it
 * makes is refused - or all of them at once. This device's own extra sessions
 * can be ended from its row too. Below the list, a QR code signs another
 * device in (LinkDeviceCard).
 */
export function DevicesPanel() {
  const t = useT();
  const toast = useToast();
  const { locale } = useLocale();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me/sessions', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setDevices(((await res.json()) as { sessions: Device[] }).sessions);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string | 'others') {
    setBusy(id);
    try {
      const res = await fetch(id === 'others' ? '/api/me/sessions' : `/api/me/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 404) {
        toast.error(t(body.error ?? 'errors.generic'));
        return;
      }
      // Revoking on this device's row ends only its OTHER sessions: the row stays.
      const onlyThisSession = (row: Device) => ({ ...row, sessionCount: 1 });
      setDevices(
        (rows) =>
          rows?.flatMap((row) => {
            if (row.current) return id === 'others' || row.id === id ? [onlyThisSession(row)] : [row];
            return id === 'others' || row.id === id ? [] : [row];
          }) ?? rows,
      );
      toast.success(
        t(
          id === 'others'
            ? 'settings.devices.revokedOthers'
            : devices?.find((row) => row.id === id)?.current
              ? 'settings.devices.revokedExtra'
              : 'settings.devices.revoked',
        ),
      );
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setBusy(null);
    }
  }

  const format = (iso: string) =>
    new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // Sessions other than this one: other devices, and this device's extras.
  const others = devices?.reduce((sum, row) => sum + (row.current ? row.sessionCount - 1 : row.sessionCount), 0) ?? 0;

  return (
    <section className="card p-6" aria-labelledby="devices-heading">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="devices-heading" className="text-md font-medium tracking-tight text-fg">
            {t('settings.devices.title')}
          </h2>
          <p className="mt-1 text-xs text-fg-muted">{t('settings.devices.description')}</p>
        </div>
        {others > 0 && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void revoke('others')}
            className="btn-secondary h-8 shrink-0 text-xs"
          >
            {busy === 'others' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t('settings.devices.revokeOthers')}
          </button>
        )}
      </div>

      {failed ? (
        <p className="text-sm text-fg-muted">
          {t('errors.generic')}{' '}
          <button type="button" onClick={() => void load()} className="font-medium text-accent hover:underline">
            {t('common.retry')}
          </button>
        </p>
      ) : !devices ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-muted" />
          ))}
        </div>
      ) : (
        <ul className="divide-y divide-edge">
          {devices.map((row) => {
            const Icon = row.device.mobile ? Smartphone : Laptop;
            const name = [row.device.browser, row.device.os].filter(Boolean).join(' · ') || t('settings.devices.unknown');
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-inset text-fg-muted">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                    {name}
                    {row.current && (
                      <span className="rounded-full bg-verified-soft px-2 py-px text-2xs font-semibold text-verified-fg">
                        {t('settings.devices.thisDevice')}
                      </span>
                    )}
                    {row.sessionCount > 1 && (
                      <span
                        className="rounded-full bg-surface-inset px-2 py-px text-2xs font-semibold text-fg-muted"
                        title={t('settings.devices.sessionsHint')}
                      >
                        {t('settings.devices.sessions', { count: row.sessionCount })}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {t('settings.devices.signedIn', { when: format(row.signedInAt) })} ·{' '}
                    {t('settings.devices.lastActive', { when: format(row.lastActiveAt) })}
                  </p>
                </div>
                {(!row.current || row.sessionCount > 1) && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void revoke(row.id)}
                    className="btn-ghost h-8 shrink-0 text-xs text-danger hover:bg-danger-soft"
                  >
                    {busy === row.id && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                    {t(row.current ? 'settings.devices.revokeExtra' : 'settings.devices.revoke')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <LinkDeviceCard onLinked={load} />
    </section>
  );
}
