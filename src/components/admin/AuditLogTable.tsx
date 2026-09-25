'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, Loader2, Lock } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import {
  Badge,
  EmptyState,
  ErrorState,
  Pagination,
  TableSkeleton,
  formatDateTime,
  useAdminFetch,
  useToast,
} from './primitives';

type LogRow = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  userAgent: string | null;
  /** Present only on admin actions; see the note in the API route. */
  ip: string | null;
  /** NULL on rows written before this column existed - not defaulted. */
  result: string | null;
  createdAt: string;
  actor: { id: string; nickname: string; role: string } | null;
};

type Response = {
  logs: LogRow[];
  page: { page: number; pageSize: number; total: number; pageCount: number };
};

/**
 * The audit log viewer.
 *
 * Read-only by construction, at three levels: this component renders no
 * mutation control, the API exposes only GET, and campusnotehub_app holds only
 * INSERT and SELECT on the table (0001_invariants.sql revokes UPDATE and
 * DELETE). Even a compromised admin session cannot rewrite history through the
 * application - the grant is the backstop, and the UI simply agrees with it.
 *
 * There is no IP column because the schema stores no addresses anywhere. Audit
 * rows carry a device fingerprint and a user agent instead, a deliberate choice
 * documented in the model: campus NAT makes an address a poor identifier and a
 * collective-punishment risk. The fingerprint is a ban anchor, so it is not
 * rendered in bulk here either.
 */
export function AuditLogTable() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (!value) next.delete(key);
        else next.set(key, value);
      }
      if (!('page' in updates)) next.delete('page');
      router.replace(`/admin/audit-logs?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  const query = useMemo(() => {
    const next = new URLSearchParams(params.toString());
    if (!next.has('pageSize')) next.set('pageSize', '50');
    return next.toString();
  }, [params]);

  const { data, error, loading, reload } = useAdminFetch<Response>(`/api/admin/audit-logs?${query}`);

  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  /**
   * Downloads the CURRENT view as .xlsx.
   *
   * The same query string the table is showing is forwarded, so the file
   * matches what the operator is looking at rather than silently exporting
   * everything - an export that disagrees with the screen above it is worse
   * than no export, because it looks authoritative.
   *
   * The response is fetched as a blob and saved through an object URL rather
   * than by pointing the browser at the endpoint. A plain <a href> would issue
   * a top-level navigation, and this route answers 401/403 with JSON - which
   * the browser would render as a page of raw JSON where a file was expected.
   * Fetching lets a failure surface as a toast instead.
   */
  async function exportXlsx() {
    setExporting(true);
    try {
      const response = await fetch(`/api/admin/audit-logs/export?${query}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast(t(payload?.error ?? 'admin.auditLogs.exportFailed'), 'error');
        return;
      }

      if (response.headers.get('X-Export-Truncated') === 'true') {
        toast(t('admin.auditLogs.exportTruncated'), 'error');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `unipath-audit-log-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked immediately: the blob is already handed to the download, and
      // leaving the URL alive pins the whole file in memory for the session.
      URL.revokeObjectURL(url);
    } catch {
      toast(t('admin.auditLogs.exportFailed'), 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('admin.auditLogs.title')}
        description={t('admin.auditLogs.subtitle')}
        actions={
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-2xs text-fg-muted">
              <Lock className="h-3 w-3" aria-hidden="true" />
              {t('admin.auditLogs.readOnly')}
            </span>
            <button
              type="button"
              onClick={() => void exportXlsx()}
              disabled={exporting}
              className="btn-secondary px-3 py-1.5 text-sm"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {exporting ? t('admin.auditLogs.exporting') : t('admin.auditLogs.export')}
            </button>
          </div>
        }
      />

      <div className="card mb-3 flex flex-wrap items-end gap-2 p-3">
        <label className="w-full min-w-0 flex-1 basis-56">
          <span className="sr-only">{t('admin.auditLogs.searchLabel')}</span>
          <input
            type="search"
            defaultValue={params.get('q') ?? ''}
            onChange={(event) => setParam({ q: event.target.value || null })}
            placeholder={t('admin.auditLogs.searchPlaceholder')}
            className="input py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('admin.auditLogs.columns.entityType')}</span>
          <input
            defaultValue={params.get('entityType') ?? ''}
            onChange={(event) => setParam({ entityType: event.target.value || null })}
            placeholder="user"
            className="input py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.from')}</span>
          <input
            type="date"
            defaultValue={params.get('createdFrom') ?? ''}
            onChange={(event) => setParam({ createdFrom: event.target.value || null })}
            className="input py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.to')}</span>
          <input
            type="date"
            defaultValue={params.get('createdTo') ?? ''}
            onChange={(event) => setParam({ createdTo: event.target.value || null })}
            className="input py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-sm">
            <caption className="sr-only">{t('admin.auditLogs.title')}</caption>
            <thead className="border-b border-edge bg-surface-muted text-2xs uppercase tracking-wide">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.timestamp')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.actor')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.action')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.entityType')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.entityId')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.status')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.ip')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.device')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.auditLogs.columns.metadata')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={9} className="p-0"><TableSkeleton rows={10} cols={6} /></td></tr>}

              {!loading && data?.logs.length === 0 && (
                <tr><td colSpan={9}><EmptyState title={t('admin.auditLogs.empty')} hint={t('admin.auditLogs.emptyHint')} /></td></tr>
              )}

              {!loading && data?.logs.map((log) => {
                const hasMetadata = Boolean(log.before || log.after);
                const open = expanded === log.id;
                return (
                  <tr key={log.id} className="border-b border-edge align-top last:border-0 hover:bg-surface-muted">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-2xs text-fg-muted">
                      {formatDateTime(log.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-2xs">
                      {log.actor ? (
                        <Link href={`/admin/users/${log.actor.id}`} className="text-fg underline-offset-2 hover:underline">
                          @{log.actor.nickname}
                        </Link>
                      ) : (
                        // actorId is onDelete: SetNull, so a removed actor
                        // leaves the row intact but unattributed. Saying
                        // "system" would be a lie; this says what happened.
                        <span className="text-fg-subtle">{t('admin.auditLogs.actorGone')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2"><Badge tone="accent">{log.action}</Badge></td>
                    <td className="px-3 py-2 text-2xs text-fg-muted">{log.entityType}</td>
                    <td className="px-3 py-2 font-mono text-2xs text-fg-subtle">
                      {log.entityId ? (
                        <button
                          type="button"
                          onClick={() => setParam({ entityId: log.entityId })}
                          className="underline-offset-2 hover:underline"
                        >
                          {log.entityId}
                        </button>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {log.result ? (
                        <Badge tone={log.result === 'SUCCESS' ? 'positive' : log.result === 'DENIED' ? 'warning' : 'danger'}>
                          {log.result}
                        </Badge>
                      ) : (
                        // Blank rather than assumed. Rows written before this
                        // column existed have no outcome recorded, and
                        // defaulting them to SUCCESS would invent a fact.
                        <span className="text-2xs text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-2xs text-fg-muted">
                      {/* Populated for admin actions only - ordinary user
                          traffic is not address-logged. See the API route. */}
                      {log.ip ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-2xs text-fg-muted">
                      {log.userAgent ? (
                        // Truncated in the cell, full string on hover: a UA is
                        // 150+ characters and would blow the column open.
                        <span className="block max-w-[16rem] truncate" title={log.userAgent}>
                          {log.userAgent}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-2xs">
                      {!hasMetadata ? (
                        <span className="text-fg-subtle">—</span>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setExpanded(open ? null : log.id)}
                            aria-expanded={open}
                            className="text-fg-muted underline-offset-2 hover:underline"
                          >
                            {open ? t('admin.auditLogs.hide') : t('admin.auditLogs.show')}
                          </button>
                          {open && (
                            <pre className="mt-1.5 max-w-md overflow-x-auto rounded-lg border border-edge bg-surface-inset p-2 text-2xs text-fg-muted">
{JSON.stringify({ before: log.before, after: log.after }, null, 2)}
                            </pre>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && <ErrorState message={t(error)} onRetry={reload} />}

        {data && (
          <Pagination
            page={data.page.page}
            pageCount={data.page.pageCount}
            total={data.page.total}
            onPage={(page) => setParam({ page: String(page) })}
          />
        )}
      </div>
    </>
  );
}
