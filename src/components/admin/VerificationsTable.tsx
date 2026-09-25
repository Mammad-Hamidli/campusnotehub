'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { EyeOff, ExternalLink, RotateCcw } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Pagination,
  SortHeader,
  StatusBadge,
  TableSkeleton,
  formatDateTime,
  useAdminFetch,
  useToast,
} from './primitives';

type Case = {
  id: string;
  status: string;
  attempt: number;
  submittedAt: string;
  decidedAt: string | null;
  verdict: string | null;
  confidence: number | null;
  failureCodes: string[];
  moderatorNote: string | null;
  /**
   * Null when the applicant's account no longer exists (deleted, or wiped by
   * a purge) - the case outlives it as history. Every read below must allow
   * for that; `kase.user.id` on such a row is what crashed this page.
   */
  user: {
    id: string;
    fullName: string;
    nickname: string;
    verificationStatus: string;
    /** STUDENT or TEACHER - decides which documents the case should carry. */
    role: string;
    department: string | null;
    academicTitle: string | null;
    dateOfBirth: string | null;
    university: { code: string; nameEn: string } | null;
  } | null;
  reviewer: { id: string; nickname: string } | null;
  reviewable: boolean;
  minutesLeft: number | null;
  dismissedAt: string | null;
  dismissedBy: { id: string; nickname: string } | null;
};

type Response = {
  cases: Case[];
  page: { page: number; pageSize: number; total: number; pageCount: number };
};

/** Legacy rows repeat codes, and some predate the field entirely. */
const uniqueCodes = (codes: string[] | null | undefined) => [...new Set(codes ?? [])];

const STATUSES = ['NEEDS_REVIEW', 'PROCESSING', 'REJECTED', 'VERIFIED', 'BANNED', 'UNVERIFIED'];

/**
 * The verification case list.
 *
 * This screen reports; it does not decide. Approve/Reject/Ban live in the
 * existing ModerationConsole at /admin/moderation, which is the only surface
 * that holds a per-case decryption secret and the only one that can show the
 * documents. Duplicating those buttons here would mean either building a second
 * review flow or shipping a decision button that acts on a case the operator
 * has not looked at - and "approve without opening" is exactly the failure the
 * hybrid pipeline exists to prevent. So a reviewable row links across instead.
 *
 * ---------------------------------------------------------------------------
 * TWO CHANGES WORTH EXPLAINING
 * ---------------------------------------------------------------------------
 * THE PRIORITY COLUMN IS GONE. It showed `reviewPriority`, a number the policy
 * computes to ORDER the queue - and the queue was already sorted by it, so the
 * column restated in digits what the row order was already showing, and cost a
 * column's width on a table that is 10 columns wide. Nothing an operator can
 * do changes it, so it was information without an action. The field still
 * exists, still orders the moderator queue, and is still a permitted `sort`
 * value for a bookmarked URL.
 *
 * CLEARING A ROW IS A VIEW FILTER, NOT A DELETE. "Clear from list" writes a
 * `dismissedAt` timestamp and the listing hides those rows by default. The
 * case, its verdict, its moderator and its audit trail are untouched, the
 * account is untouched, and "Show cleared" brings the row straight back.
 * Permanent account deletion is a different action, on a different screen,
 * ADMIN-only, and requires typing the target's nickname.
 */
export function VerificationsTable() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (!value) next.delete(key);
        else next.set(key, value);
      }
      if (!('page' in updates)) next.delete('page');
      router.replace(`/admin/verifications?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  const query = useMemo(() => {
    const next = new URLSearchParams(params.toString());
    if (!next.has('pageSize')) next.set('pageSize', '25');
    return next.toString();
  }, [params]);

  const { data, error, loading, reload } = useAdminFetch<Response>(
    `/api/admin/verification/cases?${query}`,
  );

  const toast = useToast();
  const [pendingDismiss, setPendingDismiss] = useState<Case | null>(null);
  const [busy, setBusy] = useState(false);

  const showDismissed = params.get('includeDismissed') === 'true';
  // Rows with no id cannot be keyed, dismissed or reviewed; a malformed body
  // renders as an empty list rather than taking the page down.
  const cases = (Array.isArray(data?.cases) ? data.cases : []).filter((kase): kase is Case => Boolean(kase?.id));

  /**
   * Hides or restores a row.
   *
   * `dismissed` is passed explicitly rather than toggled from local state, so
   * a stale row in a list somebody left open for ten minutes cannot flip the
   * wrong way. The server refuses to hide an UNDECIDED case outright - a queue
   * that can lose people waiting on a decision is worse than a crowded one.
   */
  async function setDismissed(kase: Case, dismissed: boolean) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/verification/cases/${kase.id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dismissed }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast(t(payload?.error ?? 'errors.generic'), 'error');
        return;
      }
      toast(t('admin.common.done'), 'success');
      setPendingDismiss(null);
      reload();
    } catch {
      toast(t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const sort = params.get('sort') ?? 'submittedAt';
  const order = (params.get('order') ?? 'desc') as 'asc' | 'desc';
  const onSort = (field: string) =>
    setParam({ sort: field, order: sort === field && order === 'desc' ? 'asc' : 'desc' });

  return (
    <>
      <PageHeader
        title={t('admin.verifications.title')}
        description={t('admin.verifications.subtitle')}
        actions={
          <Link href="/admin/moderation" className="btn-primary">
            {t('admin.verifications.openConsole')}
          </Link>
        }
      />

      <div className="card mb-3 flex flex-wrap items-end gap-2 p-3">
        <label className="w-full min-w-0 flex-1 basis-56">
          <span className="sr-only">{t('admin.verifications.searchLabel')}</span>
          <input
            type="search"
            defaultValue={params.get('q') ?? ''}
            onChange={(event) => setParam({ q: event.target.value || null })}
            placeholder={t('admin.verifications.searchPlaceholder')}
            className="input py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('admin.verifications.columns.status')}</span>
          <select
            value={params.get('status') ?? ''}
            onChange={(event) => setParam({ status: event.target.value || null })}
            className="input py-1.5 text-sm"
          >
            <option value="">{t('admin.common.all')}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>

        {/* Cleared rows are hidden, not gone. This makes that reversible in
            one click, which is what keeps "tidy the queue" from feeling like
            destroying something. */}
        <button
          type="button"
          onClick={() => setParam({ includeDismissed: showDismissed ? null : 'true' })}
          aria-pressed={showDismissed}
          className={showDismissed ? 'btn-primary py-1.5 text-sm' : 'btn-secondary py-1.5 text-sm'}
        >
          {showDismissed ? t('admin.verifications.hideDismissed') : t('admin.verifications.showDismissed')}
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse text-sm">
            <caption className="sr-only">{t('admin.verifications.title')}</caption>
            <thead className="border-b border-edge bg-surface-muted text-2xs uppercase tracking-wide">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.verifications.columns.user')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('auth.register.accountType')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.verifications.columns.university')}</th>
                <SortHeader label={t('admin.verifications.columns.submitted')} field="submittedAt" sort={sort} order={order} onSort={onSort} />
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.verifications.columns.status')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.verifications.columns.verdict')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.verifications.columns.codes')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.verifications.columns.reviewer')}</th>
                <SortHeader label={t('admin.verifications.columns.decided')} field="decidedAt" sort={sort} order={order} onSort={onSort} />
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} className="p-0"><TableSkeleton rows={8} cols={7} /></td></tr>
              )}

              {!loading && cases.length === 0 && (
                <tr><td colSpan={10}><EmptyState title={t('admin.verifications.empty')} hint={t('admin.verifications.emptyHint')} /></td></tr>
              )}

              {!loading && cases.map((kase) => (
                <tr
                  key={kase.id}
                  className={`border-b border-edge last:border-0 hover:bg-surface-muted ${
                    kase.dismissedAt ? 'opacity-55' : ''
                  }`}
                >
                  <td className="px-3 py-2">
                    {kase.user ? (
                      <>
                        <Link href={`/admin/users/${kase.user.id}`} className="font-medium text-fg underline-offset-2 hover:underline">
                          {kase.user.fullName}
                        </Link>
                        <span className="mt-0.5 block text-2xs text-fg-subtle">@{kase.user.nickname}</span>
                      </>
                    ) : (
                      <span className="font-medium italic text-fg-subtle">{t('admin.verifications.deletedAccount')}</span>
                    )}
                    {kase.dismissedAt && (
                      <Badge tone="neutral">{t('admin.verifications.dismissed')}</Badge>
                    )}
                  </td>
                  {/* The account type decides which documents this case
                      should contain, so it belongs next to the person rather
                      than buried in the detail view. */}
                  <td className="whitespace-nowrap px-3 py-2">
                    {kase.user ? <StatusBadge kind="role" value={kase.user.role} /> : '—'}
                    {(kase.user?.role === 'TEACHER' || kase.user?.role === 'MENTOR') &&
                      kase.user.department && (
                        <span className="mt-0.5 block text-2xs text-fg-subtle">
                          {kase.user.department}
                        </span>
                      )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-fg-muted">{kase.user?.university?.code ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-2xs text-fg-muted">{formatDateTime(kase.submittedAt)}</td>
                  <td className="px-3 py-2"><StatusBadge kind="verification" value={kase.status} /></td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">
                    {kase.verdict ?? '—'}
                    {kase.confidence != null && (
                      <span className="mt-0.5 block tabular-nums text-fg-subtle">{kase.confidence.toFixed(3)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[16rem] flex-wrap gap-1">
                      {uniqueCodes(kase.failureCodes).slice(0, 4).map((code) => (
                        <Badge key={code} tone="warning">{code}</Badge>
                      ))}
                      {uniqueCodes(kase.failureCodes).length > 4 && (
                        <span className="text-2xs text-fg-subtle">+{uniqueCodes(kase.failureCodes).length - 4}</span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-2xs text-fg-muted">
                    {kase.reviewer ? `@${kase.reviewer.nickname}` : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-2xs text-fg-muted">{formatDateTime(kase.decidedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {kase.reviewable && kase.user ? (
                        <Link href="/admin/moderation" className="btn-secondary px-2 py-1 text-2xs">
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          {t('admin.verifications.review')}
                          {kase.minutesLeft != null && (
                            <span className="tabular-nums text-fg-subtle">{kase.minutesLeft}m</span>
                          )}
                        </Link>
                      ) : (
                        <span className="text-2xs text-fg-subtle">
                          {kase.status === 'NEEDS_REVIEW' && kase.user ? t('admin.verifications.expired') : '—'}
                        </span>
                      )}

                      {kase.dismissedAt ? (
                        <button
                          type="button"
                          onClick={() => void setDismissed(kase, false)}
                          disabled={busy}
                          title={t('admin.verifications.restore')}
                          aria-label={t('admin.verifications.restore')}
                          className="rounded-md p-1.5 text-accent transition hover:bg-accent-soft"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDismiss(kase)}
                          title={t('admin.verifications.dismiss')}
                          aria-label={t('admin.verifications.dismiss')}
                          className="rounded-md p-1.5 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
                        >
                          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && <ErrorState message={t(error)} onRetry={reload} />}

        {data?.page && (
          <Pagination
            page={data.page.page}
            pageCount={data.page.pageCount}
            total={data.page.total}
            onPage={(page) => setParam({ page: String(page) })}
          />
        )}
      </div>

      {/* The body text states plainly what this does NOT do. Conflating "clear
          from my list" with "delete the account" is the expensive mistake here,
          and the dialog is the last place to prevent it. */}
      <ConfirmDialog
        open={pendingDismiss !== null}
        busy={busy}
        tone="primary"
        title={t('admin.verifications.dismissTitle')}
        body={t('admin.verifications.dismissBody')}
        confirmLabel={t('admin.verifications.dismissConfirm')}
        onCancel={() => {
          if (busy) return;
          setPendingDismiss(null);
        }}
        onConfirm={() => {
          if (pendingDismiss) void setDismissed(pendingDismiss, true);
        }}
      />
    </>
  );
}
