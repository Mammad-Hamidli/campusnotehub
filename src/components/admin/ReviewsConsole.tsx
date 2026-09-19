'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Download, Loader2, Trash2, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  TableSkeleton,
  formatDateTime,
  useAdminFetch,
  useToast,
} from './primitives';

/**
 * The review queue: PocketMentor applications, uploaded UniNotes and - for
 * ADMINs - account deletion requests.
 *
 * The first two follow the same rule - nothing reaches a public listing until
 * a moderator approves it - so they share one decision control. Rejecting
 * requires a reason because the applicant or seller is emailed it. Deletion
 * requests are ADMIN-only (deleting an account is ADMIN-only everywhere) and
 * confirm an approval with the same type-the-nickname dialog as the users
 * panel.
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

type DeletionRequest = {
  userId: string;
  reason: string | null;
  requestedAt: string;
  /** Available + escrowed, minor units. Deleting strands whatever is here. */
  balanceMinor: number | null;
  user: {
    nickname: string;
    fullName: string;
    email: string;
    role: string;
    accountStatus: string;
    createdAt: string;
    deleted: boolean;
  } | null;
};

type Decision = 'APPROVE' | 'REJECT';

export type ReviewTab = 'mentors' | 'notes' | 'deletions';

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

export function ReviewsConsole({
  canReviewDeletions = false,
  initialTab = 'mentors',
}: {
  /** ADMIN tier only; the API refuses a moderator regardless. */
  canReviewDeletions?: boolean;
  /** From ?tab=, so the admins' "new deletion request" notification lands on the right queue. */
  initialTab?: ReviewTab;
}) {
  const t = useT();
  const tabs: ReviewTab[] = canReviewDeletions ? ['mentors', 'notes', 'deletions'] : ['mentors', 'notes'];
  const [tab, setTab] = useState<ReviewTab>(tabs.includes(initialTab) ? initialTab : 'mentors');

  return (
    <>
      <PageHeader title={t('admin.reviews.title')} description={t('admin.reviews.subtitle')} />

      <div role="tablist" className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map((key) => (
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

      {tab === 'mentors' ? <MentorApplications /> : tab === 'notes' ? <PendingNotes /> : <DeletionRequests />}
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
      <label className="flex w-full min-w-0 flex-1 basis-56 flex-col gap-1">
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

function DeletionRequests() {
  const t = useT();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminFetch<{ requests: DeletionRequest[] }>(
    '/api/admin/deletion-requests?status=PENDING',
  );
  const [confirming, setConfirming] = useState<DeletionRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);

  async function run(userId: string, decision: Decision, reason: string) {
    try {
      await decide(`/api/admin/deletion-requests/${userId}`, decision, reason);
      toast(t(decision === 'APPROVE' ? 'admin.deletions.approved' : 'admin.reviews.rejected'));
      reload();
    } catch (cause) {
      toast(t((cause as Error).message), 'error');
    }
  }

  if (error) return <ErrorState message={t(error)} onRetry={reload} />;
  if (loading) return <TableSkeleton rows={4} cols={3} />;
  if (!data?.requests.length) return <EmptyState title={t('admin.deletions.empty')} />;

  return (
    <>
      <ul className="space-y-3">
        {data.requests.map((r) => {
          const reason = rejectReasons[r.userId] ?? '';
          const holdsMoney = (r.balanceMinor ?? 0) > 0;
          return (
            <li key={r.userId} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-fg">@{r.user?.nickname ?? r.userId}</span>
                {r.user?.fullName && <span className="text-sm text-fg-muted">{r.user.fullName}</span>}
                {r.user && <Badge>{r.user.role}</Badge>}
                {r.user?.deleted && <Badge tone="danger">{t('admin.deletions.alreadyDeleted')}</Badge>}
                <span className="ml-auto text-2xs text-fg-subtle">
                  {t('admin.reviews.submitted')}: {formatDateTime(r.requestedAt)}
                </span>
              </div>

              <p className="mt-2 text-2xs text-fg-muted">
                {r.user?.email}
                {r.user && ` · ${t('admin.deletions.memberSince')}: ${formatDateTime(r.user.createdAt)}`}
                {` · ${t('admin.deletions.balance')}: ${azn(r.balanceMinor ?? 0)}`}
              </p>

              <blockquote className="mt-2 border-l-2 border-edge pl-3 text-sm text-fg-muted">
                {r.reason ? <span className="whitespace-pre-wrap">{r.reason}</span> : <em>{t('admin.deletions.noReason')}</em>}
              </blockquote>

              {/* Deletion strands wallet funds. Stated, not blocked: the admin
                  may have settled it out of band. */}
              {holdsMoney && (
                <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-fg">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('admin.deletions.balanceWarning', { amount: azn(r.balanceMinor ?? 0) })}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-edge pt-3">
                <label className="flex w-full min-w-0 flex-1 basis-56 flex-col gap-1">
                  <span className="text-2xs font-medium text-fg-muted">{t('admin.reviews.reason')}</span>
                  <input
                    className="input py-1.5 text-sm"
                    value={reason}
                    maxLength={1000}
                    onChange={(e) => setRejectReasons((prev) => ({ ...prev, [r.userId]: e.target.value }))}
                    placeholder={t('admin.deletions.rejectHint')}
                  />
                </label>
                <button
                  type="button"
                  className="btn-secondary px-3 py-1.5 text-sm text-danger"
                  disabled={rejecting !== null || reason.trim().length < 5}
                  title={reason.trim().length < 5 ? t('admin.reviews.errors.reasonRequired') : undefined}
                  onClick={async () => {
                    setRejecting(r.userId);
                    await run(r.userId, 'REJECT', reason.trim());
                    setRejecting(null);
                  }}
                >
                  {rejecting === r.userId ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  {t('admin.reviews.reject')}
                </button>
                <button
                  type="button"
                  className="btn-primary bg-danger px-3 py-1.5 text-sm hover:bg-danger"
                  disabled={!r.user || r.user.deleted}
                  onClick={() => setConfirming(r)}
                >
                  <Trash2 className="h-4 w-4" />
                  {t('admin.deletions.approve')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* One dialog for the whole list, like the users panel. The nickname
          must be typed back: the server's soft delete cannot be undone from
          the UI. */}
      <ConfirmDialog
        open={confirming !== null}
        busy={busy}
        title={t('admin.deletions.confirmTitle')}
        body={t('admin.deletions.confirmBody', { nickname: confirming?.user?.nickname ?? '' })}
        confirmLabel={t('admin.deletions.approve')}
        typeToConfirm={confirming?.user?.nickname}
        onCancel={() => setConfirming(null)}
        onConfirm={async (note) => {
          if (!confirming) return;
          setBusy(true);
          await run(confirming.userId, 'APPROVE', note);
          setBusy(false);
          setConfirming(null);
        }}
      />
    </>
  );
}
