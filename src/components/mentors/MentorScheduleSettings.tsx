'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import {
  SLOT_MINUTES,
  cellsToRules,
  minuteLabel,
  rulesToCells,
  type BlockedDate,
  type WeeklyRule,
} from '@/lib/mentors/schedule';
import { AvailabilityGrid } from './AvailabilityGrid';

type Settings = {
  timezone: string;
  isAcceptingBookings: boolean;
  bufferMinutes: number;
  minNoticeHours: number;
  rules: WeeklyRule[];
  blocked: BlockedDate[];
};

const BUFFERS = [0, 5, 10, 15, 30];
const DAY_MINUTES = Array.from({ length: 1440 / SLOT_MINUTES + 1 }, (_, i) => i * SLOT_MINUTES);

export function timezones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return all.includes(current) ? all : [current, ...all];
}

/** Mentor settings: weekly grid, blocked dates, booking rules. PUT /api/mentors/me/schedule. */
export function MentorScheduleSettings() {
  const t = useT();
  const [state, setState] = useState<'loading' | 'notMentor' | 'error' | 'ready'>('loading');
  const [settings, setSettings] = useState<Omit<Settings, 'rules'> | null>(null);
  const [cells, setCells] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; key: string } | null>(null);
  const [draft, setDraft] = useState<BlockedDate>({ date: '', startMinute: null, endMinute: null });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/mentors/me/schedule', { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 404) return setState('notMentor');
        if (!res.ok) return setState('error');
        const { rules, ...rest } = (await res.json()) as Settings;
        setSettings(rest);
        setCells(rulesToCells(rules));
        setState('ready');
      })
      .catch((e) => (e as Error)?.name !== 'AbortError' && setState('error'));
    return () => controller.abort();
  }, []);

  const zones = useMemo(() => (settings ? timezones(settings.timezone) : []), [settings]);

  if (state === 'loading') return <div className="card h-96 animate-pulse" aria-busy="true" />;
  if (state === 'error') return <p className="card p-6 text-sm text-fg-muted">{t('errors.generic')}</p>;
  if (state === 'notMentor' || !settings) {
    return (
      <div className="card p-6">
        <p className="text-sm text-fg">{t('mentors.schedule.notMentor')}</p>
        <Link href="/mentors/apply" className="btn-primary mt-3 px-3 py-1.5 text-sm">
          {t('mentors.becomeMentor')}
        </Link>
      </div>
    );
  }

  const update = (patch: Partial<typeof settings>) => setSettings({ ...settings, ...patch });

  function addBlocked() {
    if (!draft.date || !settings) return;
    const allDay = draft.startMinute === null;
    if (!allDay && (draft.endMinute ?? 0) <= draft.startMinute!) return;
    update({ blocked: [...settings.blocked, draft].sort((a, b) => a.date.localeCompare(b.date)) });
    setDraft({ date: '', startMinute: null, endMinute: null });
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch('/api/mentors/me/schedule', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...settings, rules: cellsToRules(cells) }),
      });
      const payload = await res.json().catch(() => ({}));
      setNotice(res.ok ? { tone: 'ok', key: 'mentors.schedule.saved' } : { tone: 'error', key: payload.error ?? 'errors.generic' });
    } catch {
      setNotice({ tone: 'error', key: 'errors.network' });
    } finally {
      setSaving(false);
    }
  }

  const field = 'input py-2 text-sm';
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <section className="card grid gap-3 p-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
          <input type="checkbox" checked={settings.isAcceptingBookings} onChange={(e) => update({ isAcceptingBookings: e.target.checked })} />
          {t('mentors.schedule.accepting')}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.schedule.timezone')}</span>
          <select className={field} value={settings.timezone} onChange={(e) => update({ timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.schedule.buffer')}</span>
          <select className={field} value={settings.bufferMinutes} onChange={(e) => update({ bufferMinutes: Number(e.target.value) })}>
            {BUFFERS.map((m) => (
              <option key={m} value={m}>{t('mentors.apply.minutes', { minutes: m })}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.schedule.minNotice')}</span>
          <input className={field} type="number" min={0} max={168} value={settings.minNoticeHours}
            onChange={(e) => update({ minNoticeHours: Math.max(0, Math.min(168, Number(e.target.value) || 0)) })} />
        </label>
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold text-fg">{t('mentors.schedule.weekly')}</h2>
        <AvailabilityGrid value={cells} onChange={setCells} />
      </section>

      <section className="card space-y-3 p-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t('mentors.schedule.blocked')}</h2>
          <p className="text-2xs text-fg-subtle">{t('mentors.schedule.blockedHint')}</p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <input type="date" min={today} className={field} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} aria-label={t('mentors.schedule.date')} />
          <label className="flex items-center gap-1.5 text-sm text-fg">
            <input type="checkbox" checked={draft.startMinute === null}
              onChange={(e) => setDraft({ ...draft, startMinute: e.target.checked ? null : 540, endMinute: e.target.checked ? null : 720 })} />
            {t('mentors.schedule.allDay')}
          </label>
          {draft.startMinute !== null && (
            <>
              <select className={field} value={draft.startMinute} onChange={(e) => setDraft({ ...draft, startMinute: Number(e.target.value) })} aria-label={t('mentors.schedule.from')}>
                {DAY_MINUTES.slice(0, -1).map((m) => <option key={m} value={m}>{minuteLabel(m)}</option>)}
              </select>
              <select className={field} value={draft.endMinute ?? 1440} onChange={(e) => setDraft({ ...draft, endMinute: Number(e.target.value) })} aria-label={t('mentors.schedule.to')}>
                {DAY_MINUTES.slice(1).map((m) => <option key={m} value={m}>{minuteLabel(m)}</option>)}
              </select>
            </>
          )}
          <button type="button" className="btn-secondary px-2.5 py-2 text-xs" onClick={addBlocked} disabled={!draft.date}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('mentors.schedule.addBlocked')}
          </button>
        </div>

        {settings.blocked.length > 0 && (
          <ul className="divide-y divide-edge rounded-lg border border-edge">
            {settings.blocked.map((b, i) => (
              <li key={`${b.date}-${i}`} className="flex items-center justify-between px-3 py-2 text-sm text-fg">
                <span className="tabular-nums">
                  {b.date} ·{' '}
                  {b.startMinute === null ? t('mentors.schedule.allDay') : `${minuteLabel(b.startMinute)}–${minuteLabel(b.endMinute ?? 1440)}`}
                </span>
                <button type="button" aria-label={t('mentors.apply.remove')} className="btn-ghost px-2 py-1"
                  onClick={() => update({ blocked: settings.blocked.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary px-4 py-2 text-sm">
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('mentors.schedule.save')}
        </button>
        {notice && (
          <p role="status" className={`text-sm ${notice.tone === 'ok' ? 'text-verified' : 'text-danger-fg'}`}>
            {t(notice.key)}
          </p>
        )}
      </div>
    </div>
  );
}
