'use client';

import { useEffect, useState } from 'react';
import { Bot, Loader2, Play } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { Badge, ConfirmDialog, formatDateTime, useAdminFetch, useToast } from './primitives';

type Status = {
  running: boolean;
  startedAt: string | null;
  queued: number;
  canRun: boolean;
  lastRun: {
    finishedAt: string;
    processed: number;
    approved: number;
    flagged: number;
    skipped: number;
    remaining: number;
    stoppedReason: string;
  } | null;
};

const POLL_MS = 4_000;
/** After a click the run starts in after(), a moment later: keep watching this long. */
const START_GRACE_MS = 20_000;

/**
 * The AI identity check, on demand.
 *
 * The nightly cron keeps running at 00:00 Baku regardless; "Run now" starts
 * the same batch immediately (POST /api/admin/verification/ai-batch). Shown to
 * moderators as status, with the button for ADMINs only - the server decides
 * that (`canRun`) and enforces it again on POST.
 */
export function AiBatchControl({ onFinished }: { onFinished?: () => void }) {
  const t = useT();
  const toast = useToast();
  const { data, error, reload } = useAdminFetch<Status>('/api/admin/verification/ai-batch');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Set by a click: the last run known then, and how long to wait for the new one to show. */
  const [pending, setPending] = useState<{ since: string | null; until: number } | null>(null);

  const running = Boolean(data?.running);
  const lastFinished = data?.lastRun?.finishedAt ?? null;
  // Until the lease shows up (or a newer run has already finished), the click is still "starting".
  const starting = pending !== null && lastFinished === pending.since && Date.now() < pending.until;
  const watching = running || starting;

  // Poll only while a run is (or is about to be) in progress.
  useEffect(() => {
    if (!watching) return;
    const timer = window.setTimeout(reload, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [watching, data, reload]);

  // A run finished while watching: the case list behind this card changed.
  const [seenFinished, setSeenFinished] = useState<string | null>(null);
  useEffect(() => {
    if (!lastFinished || lastFinished === seenFinished) return;
    if (seenFinished !== null) onFinished?.();
    setSeenFinished(lastFinished);
  }, [lastFinished, seenFinished, onFinished]);

  async function run() {
    setBusy(true);
    try {
      const response = await fetch('/api/admin/verification/ai-batch', { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast(t(payload?.error ?? 'errors.generic'), 'error');
        return;
      }
      toast(t('admin.verifications.ai.started', { count: payload.queued }), 'success');
      setConfirming(false);
      setPending({ since: lastFinished, until: Date.now() + START_GRACE_MS });
      reload();
    } catch {
      toast(t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return null;

  const last = data?.lastRun;
  return (
    <section className="card mb-3 flex flex-wrap items-center justify-between gap-3 p-3" aria-live="polite">
      <div className="min-w-0 space-y-1">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
          <Bot className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          {t('admin.verifications.ai.title')}
          {data && (
            <Badge tone={running ? 'accent' : data.queued > 0 ? 'warning' : 'neutral'}>
              {running ? t('admin.verifications.ai.running') : t('admin.verifications.ai.queued', { count: data.queued })}
            </Badge>
          )}
        </h2>
        <p className="text-xs text-fg-muted">{t('admin.verifications.ai.schedule')}</p>
        {last && (
          <p className="text-xs text-fg-muted">
            {t('admin.verifications.ai.lastRun', {
              when: formatDateTime(last.finishedAt),
              approved: last.approved,
              flagged: last.flagged,
              remaining: last.remaining,
            })}{' '}
            · {t(`admin.verifications.ai.stop.${last.stoppedReason}`)}
          </p>
        )}
      </div>

      {data?.canRun && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={watching || busy || data.queued === 0}
          className="btn-primary shrink-0"
        >
          {watching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          {t(watching ? 'admin.verifications.ai.running' : 'admin.verifications.ai.runNow')}
        </button>
      )}

      <ConfirmDialog
        open={confirming}
        tone="primary"
        title={t('admin.verifications.ai.confirmTitle')}
        body={t('admin.verifications.ai.confirmBody', { count: data?.queued ?? 0 })}
        confirmLabel={t('admin.verifications.ai.runNow')}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={run}
      />
    </section>
  );
}
