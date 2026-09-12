'use client';

import { useState } from 'react';
import { Check, Download, Loader2, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import {
  Badge,
  EmptyState,
  ErrorState,
  TableSkeleton,
  formatDateTime,
  useAdminFetch,
  useToast,
} from './primitives';

/**
 * The review queue: PocketMentor applications and uploaded UniNotes.
 *
 * Both follow the same rule - nothing reaches a public listing until a
 * moderator approves it - so they share one decision control. Rejecting
 * requires a reason because the applicant or seller is emailed it.
 */

type Application = {
  userId: string;
  headline: string;
  bio: string;
  industry: string;
  expertise: string[];
  experiences: { company: string; role: string; years: number }[];
  education: { institution: string; degree: string; field: string | null; graduationYear: number | null }[];
  languages: string[];
  hourlyRateMinor: number;
  sessionMinutes: number;
  linkedinUrl: string | null;
  totalYears: number;
  submittedAt: string;
  applicant: { nickname: string; fullName: string; email: string; university: string | null } | null;
};

type PendingNote = {
  id: string;
  title: string;
  description: string;
  subject: string;
  priceMinor: number;
  createdAt: string;
  university: string | null;
  seller: { nickname: string; email: string } | null;
  attachment: { fileName: string; mime: string; sizeBytes: number } | null;
};

type Decision = 'APPROVE' | 'REJECT';

async function decide(url: string, decision: Decision, reason: string): Promise<void> {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, reason: reason || undefined }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? 'errors.generic');
  }
}

const azn = (minor: number) => (minor > 0 ? `${(minor / 100).toFixed(2)} AZN` : '—');

export function ReviewsConsole() {
  const t = useT();
  const [tab, setTab] = useState<'mentors' | 'notes'>('mentors');

  return (
    <>
      <PageHeader title={t('admin.reviews.title')} description={t('admin.reviews.subtitle')} />

      <div role="tablist" className="mb-4 flex gap-1.5">
        {(['mentors', 'notes'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              tab === key
                ? 'bg-accent text-accent-fg'
                : 'border border-edge bg-surface text-fg-muted hover:border-edge-strong'
            }`}
          >
            {t(`admin.reviews.tabs.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'mentors' ? <MentorApplications /> : <PendingNotes />}
    </>
  );
}

function DecisionBar({ onDecide }: { onDecide: (decision: Decision, reason: string) => Promise<void> }) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<Decision | null>(null);

  async function run(decision: Decision) {
    setBusy(decision);
    try {
      await onDecide(decision, reason.trim());
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-edge pt-3">
      <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
        <span className="text-2xs font-medium text-fg-muted">{t('admin.reviews.reason')}</span>
        <input
          className="input py-1.5 text-sm"
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('admin.reviews.reasonHint')}
        />
      </label>
      <button
        type="button"
        className="btn-primary px-3 py-1.5 text-sm"
        disabled={busy !== null}
        onClick={() => void run('APPROVE')}
      >
        {busy === 'APPROVE' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        {t('admin.reviews.approve')}
      </button>
      <button
        type="button"
        className="btn-secondary px-3 py-1.5 text-sm text-danger"
        disabled={busy !== null || reason.trim().length < 5}
        title={reason.trim().length < 5 ? t('admin.reviews.errors.reasonRequired') : undefined}
        onClick={() => void run('REJECT')}
      >
        {busy === 'REJECT' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
        {t('admin.reviews.reject')}
      </button>
    </div>
  );
}

function MentorApplications() {
  const t = useT();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminFetch<{ applications: Application[] }>(
    '/api/admin/mentor-applications?status=PENDING',
  );

  if (error) return <ErrorState message={t(error)} onRetry={reload} />;
  if (loading) return <TableSkeleton rows={4} cols={3} />;
  if (!data?.applications.length) return <EmptyState title={t('admin.reviews.emptyMentors')} />;

  return (
    <ul className="space-y-3">
      {data.applications.map((a) => (
        <li key={a.userId} className="card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">@{a.applicant?.nickname ?? a.userId}</span>
            {a.applicant?.fullName && <span className="text-sm text-fg-muted">{a.applicant.fullName}</span>}
            {a.applicant?.university && <Badge>{a.applicant.university}</Badge>}
            <Badge tone="accent">{a.industry}</Badge>
            <span className="ml-auto text-2xs text-fg-subtle">
              {t('admin.reviews.submitted')}: {formatDateTime(a.submittedAt)}
            </span>
          </div>
          <p className="mt-2 text-sm font-medium text-fg">{a.headline}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-fg-muted">{a.bio}</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                {t('admin.reviews.experience')} · {a.totalYears}
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-fg">
                {a.experiences.map((e, i) => (
                  <li key={i}>
                    {e.role} @ {e.company} · {e.years}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                {t('admin.reviews.education')}
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-fg">
                {a.education.length === 0 && <li className="text-fg-subtle">—</li>}
                {a.education.map((e, i) => (
                  <li key={i}>
                    {e.degree}
                    {e.field ? `, ${e.field}` : ''} — {e.institution}
                    {e.graduationYear ? ` (${e.graduationYear})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {a.expertise.map((tag) => (
              <span key={tag} className="badge-accent">
                {tag}
              </span>
            ))}
          </div>
          <p className="mt-2 text-2xs text-fg-muted">
            {a.languages.map((l) => l.toUpperCase()).join(', ')} · {t('admin.reviews.rate')}: {azn(a.hourlyRateMinor)} ·{' '}
            {a.sessionMinutes} min
            {a.linkedinUrl && (
              <>
                {' · '}
                <a href={a.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                  LinkedIn
                </a>
              </>
            )}
            {a.applicant?.email && ` · ${a.applicant.email}`}
          </p>

          <DecisionBar
            onDecide={async (decision, reason) => {
              try {
                await decide(`/api/admin/mentor-applications/${a.userId}`, decision, reason);
                toast(t(decision === 'APPROVE' ? 'admin.reviews.approved' : 'admin.reviews.rejected'));
                reload();
              } catch (cause) {
                toast(t((cause as Error).message), 'error');
              }
            }}
          />
        </li>
      ))}
    </ul>
  );
}

function PendingNotes() {
  const t = useT();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminFetch<{ notes: PendingNote[] }>(
    '/api/admin/notes?status=PENDING_REVIEW',
  );

  if (error) return <ErrorState message={t(error)} onRetry={reload} />;
  if (loading) return <TableSkeleton rows={4} cols={3} />;
  if (!data?.notes.length) return <EmptyState title={t('admin.reviews.emptyNotes')} />;

  return (
    <ul className="space-y-3">
      {data.notes.map((n) => (
        <li key={n.id} className="card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{n.title}</span>
            <Badge>{n.subject}</Badge>
            {n.university && <Badge>{n.university}</Badge>}
            <span className="ml-auto text-2xs text-fg-subtle">
              {t('admin.reviews.submitted')}: {formatDateTime(n.createdAt)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-fg-muted">{n.description}</p>
          <p className="mt-2 text-2xs text-fg-muted">
            @{n.seller?.nickname ?? '—'}
            {n.seller?.email && ` · ${n.seller.email}`} · {t('admin.reviews.rate')}: {azn(n.priceMinor)}
            {n.attachment && ` · ${n.attachment.fileName} (${(n.attachment.sizeBytes / 1024 / 1024).toFixed(1)} MB)`}
          </p>
          {n.attachment && (
            <a href={`/api/notes/${n.id}/file`} className="btn-secondary mt-2 px-3 py-1.5 text-sm">
              <Download className="h-4 w-4" aria-hidden="true" />
              {t('admin.reviews.download')}
            </a>
          )}
          <DecisionBar
            onDecide={async (decision, reason) => {
              try {
                await decide(`/api/admin/notes/${n.id}`, decision, reason);
                toast(t(decision === 'APPROVE' ? 'admin.reviews.approved' : 'admin.reviews.rejected'));
                reload();
              } catch (cause) {
                toast(t((cause as Error).message), 'error');
              }
            }}
          />
        </li>
      ))}
    </ul>
  );
}
