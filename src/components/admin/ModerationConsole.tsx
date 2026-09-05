'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  Clock,
  Loader2,
  MonitorSmartphone,
  ShieldQuestion,
  Timer,
  X,
} from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type QueueItem = {
  id: string;
  submittedAt: string;
  minutesLeft: number;
  priority: number;
  confidence: number | null;
  codes: string[];
  verdict: string | null;
  attempt: number;
  applicant: { id: string; fullName: string; memberSince: string; university: string | null };
};

type CaseDetail = {
  case: { id: string; confidence: number | null; failureCodes: string[]; checkScores: Record<string, number> | null; expiresAt: string };
  applicant: {
    id: string;
    fullName: string;
    memberSince: string;
    university: { code: string; nameEn: string } | null;
    devices: { fingerprint: string; label: string; firstSeenAt: string }[];
  };
  documents: { kind: string; mime: string; dataUrl: string }[];
};

/**
 * The moderator console.
 *
 * This screen is the entire reason the hybrid pipeline works. The automated
 * stage deliberately has no BANNED outcome (see decide() in
 * src/lib/verification/policy.ts) - every ban on the platform is issued here,
 * by a named person, against a case they actually looked at, with a written
 * reason that lands in the audit log.
 *
 * Two design constraints that are not negotiable:
 *
 *  1. The countdown is always visible. Documents evaporate when the buffer
 *     TTL lapses, and a moderator who does not know that will leave a tab open
 *     over lunch and come back to a dead case. The timer is the honest
 *     representation of a real constraint, not decoration.
 *  2. Ban requires a typed reason and a confirmation step. Approve does not.
 *     The friction is deliberately asymmetric because the consequences are:
 *     a wrong approval is a later moderation ticket, a wrong ban costs a
 *     student their account and wallet balance with no self-service recovery.
 */
export function ModerationConsole() {
  const t = useT();
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    const res = await fetch('/api/admin/verification/queue');
    if (!res.ok) return setQueue([]);
    const data = await res.json();
    setQueue(data.cases ?? []);
  }, []);

  useEffect(() => {
    void loadQueue();
    // The buffer TTL means this list goes stale on its own. Refresh often
    // enough that a moderator does not open a case that already expired.
    const timer = setInterval(() => void loadQueue(), 60_000);
    return () => clearInterval(timer);
  }, [loadQueue]);

  return (
    <div className="mx-auto max-w-shell px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-fg">{t('admin.title')}</h1>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-fg-muted">
          <ShieldQuestion className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t('admin.review.noteAutoBan')}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <section aria-labelledby="queue-heading" className="min-w-0">
          <h2 id="queue-heading" className="mb-3 text-sm font-semibold text-fg">
            {t('admin.queue.title')}
            {queue && queue.length > 0 && (
              <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
                {queue.length}
              </span>
            )}
          </h2>

          {queue === null && <QueueSkeleton />}

          {queue?.length === 0 && (
            <p className="card p-8 text-center text-sm text-fg-muted">{t('admin.queue.empty')}</p>
          )}

          <ul className="space-y-2">
            {queue?.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelected(item.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    selected === item.id
                      ? 'border-accent bg-accent-soft shadow-raised'
                      : 'border-edge bg-surface hover:border-edge-strong'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-fg">
                        {item.applicant.fullName}
                      </span>
                      <span className="text-xs text-fg-muted">
                        {item.applicant.university ?? '—'} · #{item.attempt}
                      </span>
                    </span>
                    {item.priority >= 50 && (
                      <span className="shrink-0 rounded-md bg-danger-soft px-1.5 py-0.5 text-2xs font-bold text-danger-fg">
                        {item.priority}
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {item.codes.slice(0, 3).map((code) => (
                      <span
                        key={code}
                        className="rounded bg-surface-inset px-1.5 py-0.5 text-2xs font-medium text-fg-muted"
                      >
                        {code}
                      </span>
                    ))}
                    {item.codes.length > 3 && (
                      <span className="text-2xs text-fg-subtle">+{item.codes.length - 3}</span>
                    )}
                  </div>

                  <div className="mt-2 flex items-center justify-between text-2xs">
                    <span className="text-fg-muted">
                      {t('admin.queue.confidence')}:{' '}
                      <span className="tabular font-semibold">
                        {item.confidence !== null ? item.confidence.toFixed(2) : '—'}
                      </span>
                    </span>
                    <ExpiryPill minutes={item.minutesLeft} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="min-w-0">
          {selected ? (
            <ReviewPanel
              caseId={selected}
              onDecided={() => {
                setSelected(null);
                void loadQueue();
              }}
            />
          ) : (
            <div className="card flex min-h-[24rem] items-center justify-center p-8 text-center">
              <p className="max-w-xs text-sm text-fg-muted">{t('admin.review.title')}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ReviewPanel({ caseId, onDecided }: { caseId: string; onDecided: () => void }) {
  const t = useT();
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [expired, setExpired] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingBan, setConfirmingBan] = useState(false);

  useEffect(() => {
    setDetail(null);
    setExpired(false);
    setReason('');
    setConfirmingBan(false);

    /**
     * The decryption secret is NOT in the queue payload - it never touches
     * Postgres. In production it is handed to the moderator out of band (the
     * queue entry in the ops channel carries it), which is what makes a
     * database compromise insufficient to read pending review documents.
     *
     * For local development the secret is echoed by the dev seed; wire your
     * real secret distribution here.
     */
    const secret = sessionStorage.getItem(`review-secret:${caseId}`) ?? '';

    void fetch(`/api/admin/verification/${caseId}?secret=${encodeURIComponent(secret)}`)
      .then(async (res) => {
        if (res.status === 410) {
          setExpired(true);
          return;
        }
        if (!res.ok) return;
        setDetail(await res.json());
      })
      .catch(() => setExpired(true));
  }, [caseId]);

  async function decide(decision: 'APPROVE' | 'REJECT' | 'BAN') {
    if (decision !== 'APPROVE' && reason.trim().length < 10) return;
    if (decision === 'BAN' && !confirmingBan) {
      setConfirmingBan(true);
      return;
    }

    setPending(decision);
    const res = await fetch(`/api/admin/verification/${caseId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision,
        reason: reason.trim() || 'Approved after manual review of all four documents.',
        codes: detail?.case.failureCodes ?? [],
      }),
    });
    setPending(null);
    if (res.ok) {
      sessionStorage.removeItem(`review-secret:${caseId}`);
      onDecided();
    }
  }

  if (expired) {
    return (
      <div className="card flex min-h-[24rem] flex-col items-center justify-center gap-3 p-8 text-center">
        <Timer className="h-8 w-8 text-fg-subtle" aria-hidden="true" />
        <p className="max-w-sm text-sm text-fg-muted">{t('admin.review.bufferExpired')}</p>
        <button
          type="button"
          onClick={onDecided}
          className="rounded-lg border border-edge px-4 py-2 text-sm font-semibold text-fg"
        >
          {t('common.close')}
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="card flex min-h-[24rem] items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-fg-subtle" aria-hidden="true" />
      </div>
    );
  }

  const reasonValid = reason.trim().length >= 10;

  return (
    <div className="card animate-rise p-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge pb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-fg">{detail.applicant.fullName}</h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            {detail.applicant.university?.nameEn ?? '—'} ·{' '}
            {new Date(detail.applicant.memberSince).toLocaleDateString()}
          </p>
        </div>
        <ExpiryPill
          minutes={Math.max(
            0,
            Math.round((new Date(detail.case.expiresAt).getTime() - Date.now()) / 60_000),
          )}
        />
      </header>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {detail.documents.map((doc) => (
          <figure key={doc.kind} className="overflow-hidden rounded-lg border border-edge">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, no loader */}
            <img src={doc.dataUrl} alt={doc.kind} className="aspect-[8/5] w-full object-contain bg-surface-muted" />
            <figcaption className="border-t border-edge px-2 py-1.5 text-2xs font-medium text-fg-muted">
              {doc.kind.replaceAll('_', ' ').toLowerCase()}
            </figcaption>
          </figure>
        ))}
      </div>

      {detail.case.failureCodes.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('admin.review.signals')}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {detail.case.failureCodes.map((code) => (
              <li
                key={code}
                className="rounded-md bg-warn-soft px-2 py-1 text-xs font-medium text-warn-fg"
              >
                {code}
                {detail.case.checkScores?.[code.toLowerCase()] !== undefined && (
                  <span className="tabular ml-1 opacity-70">
                    {detail.case.checkScores[code.toLowerCase()].toFixed(2)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.applicant.devices.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden="true" />
            {t('admin.review.devices')}
          </h3>
          <ul className="space-y-1">
            {detail.applicant.devices.map((device) => (
              <li
                key={device.fingerprint}
                className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2 text-xs"
              >
                <span className="text-fg">{device.label}</span>
                <span className="font-mono text-2xs text-fg-subtle">
                  {device.fingerprint.slice(0, 12)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-5 border-t border-edge pt-4">
        <label htmlFor="reason" className="mb-1.5 block text-xs font-semibold text-fg">
          {t('admin.review.reason')}
        </label>
        <textarea
          id="reason"
          rows={2}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setConfirmingBan(false);
          }}
          className="w-full resize-none rounded-lg border border-edge px-3 py-2 text-sm
 placeholder:text-fg-subtle"
        />
        <p className="mt-1 text-2xs text-fg-muted">{t('admin.review.reasonHint')}</p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => decide('APPROVE')}
            disabled={pending !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-verified px-4 py-2 text-sm
 font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {pending === 'APPROVE' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {t('admin.review.approve')}
          </button>

          <button
            type="button"
            onClick={() => decide('REJECT')}
            disabled={pending !== null || !reasonValid}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-4 py-2
 text-sm font-semibold text-fg transition hover:bg-surface-muted
                       disabled:opacity-40"
          >
            <X className="h-4 w-4" />
            {t('admin.review.reject')}
          </button>

          <button
            type="button"
            onClick={() => decide('BAN')}
            disabled={pending !== null || !reasonValid}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold
                        transition disabled:opacity-40 ${
                          confirmingBan
                            ? 'bg-danger text-white hover:opacity-90'
                            : 'border border-danger/40 text-danger-fg hover:bg-danger-soft'
                        }`}
          >
            {pending === 'BAN' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Ban className="h-4 w-4" />
            )}
            {confirmingBan ? t('admin.review.confirmBan') : t('admin.review.ban')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExpiryPill({ minutes }: { minutes: number }) {
  const t = useT();
  const urgent = minutes < 120;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs
                  font-semibold ${
                    urgent ? 'bg-danger-soft text-danger-fg' : 'bg-surface-inset text-fg-muted'
                  }`}
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      {t('admin.queue.expiresIn', { minutes })}
    </span>
  );
}

function QueueSkeleton() {
  return (
    <ul className="space-y-2" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i} className="h-24 animate-pulse rounded-xl bg-surface-inset" />
      ))}
    </ul>
  );
}
