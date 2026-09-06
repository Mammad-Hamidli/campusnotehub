'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { BadgeCheck, Loader2, ShieldX, Snowflake, Sun, Search, Trash2, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Pagination,
  SortHeader,
  StatusBadge,
  TableSkeleton,
  formatDate,
  formatDateTime,
  useAdminFetch,
  useToast,
} from './primitives';
import {
  RoleSelect,
  FreezeDurationSelect,
  freezeUntilIso,
  isPrivilegedRole,
  type AssignableRole,
  type FreezeDurationKey,
} from './RoleControls';

type Row = {
  id: string;
  fullName: string;
  nickname: string;
  email: string;
  phone: string | null;
  role: string;
  accountStatus: string;
  verificationStatus: string;
  graduationYear: number | null;
  graduationMonth: number | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  deletedAt: string | null;
  university: { id: string; code: string; nameEn: string } | null;
  faculty: { id: string; nameEn: string } | null;
  facultyLabel: string | null;
  freeze: { frozen: boolean; until: string | null; reason: string | null; expired: boolean };
};

/** The row action currently being confirmed. */
type PendingAction =
  | { kind: 'verify'; user: Row }
  | { kind: 'reject'; user: Row }
  | { kind: 'freeze'; user: Row }
  | { kind: 'unfreeze'; user: Row }
  | { kind: 'delete'; user: Row };

type Response = {
  users: Row[];
  page: { page: number; pageSize: number; total: number; pageCount: number };
};

type University = { id: string; code: string; nameEn: string; isActive: boolean };

const ACCOUNT_STATUSES = ['ACTIVE', 'RESTRICTED', 'SUSPENDED', 'BANNED', 'DELETED'];
const VERIFICATION_STATUSES = ['UNVERIFIED', 'PROCESSING', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED', 'BANNED'];
const ROLES = ['STUDENT', 'ALUMNI', 'MENTOR', 'TEACHER', 'MODERATOR', 'ADMIN'];

/**
 * The users table.
 *
 * ---------------------------------------------------------------------------
 * WHY FILTER STATE LIVES IN THE URL
 * ---------------------------------------------------------------------------
 * Every filter, the sort, and the page number are query parameters, not
 * useState. Three things fall out of that for free and none of them work
 * otherwise: a moderator can paste "the thing I am looking at" into a ticket,
 * the browser back button steps through filters instead of leaving the page,
 * and the dashboard tiles can deep-link to a pre-filtered view. It also means
 * the client sends exactly the query string the API validates, so there is one
 * representation of a filter rather than two that can disagree.
 *
 * The search box is debounced but the URL is only rewritten once the value
 * settles - otherwise every keystroke becomes a history entry and Back stops
 * working.
 */
export function UsersTable() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();

  const [searchDraft, setSearchDraft] = useState(params.get('q') ?? '');

  // Keep the box in step when navigation changes the URL underneath it (back
  // button, or a deep link from the dashboard).
  useEffect(() => {
    setSearchDraft(params.get('q') ?? '');
  }, [params]);

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      // Any change other than paging returns to page 1: staying on page 7 of a
      // filter that now has two results shows an empty table and reads as a bug.
      if (!('page' in updates)) next.delete('page');
      router.replace(`/admin/users?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  useEffect(() => {
    const current = params.get('q') ?? '';
    if (searchDraft === current) return;
    const timer = setTimeout(() => setParam({ q: searchDraft || null }), 350);
    return () => clearTimeout(timer);
  }, [searchDraft, params, setParam]);

  const query = useMemo(() => {
    const next = new URLSearchParams(params.toString());
    if (!next.has('pageSize')) next.set('pageSize', '25');
    return next.toString();
  }, [params]);

  const { data, error, loading, reload } = useAdminFetch<Response>(`/api/admin/users?${query}`);
  const { data: uniData } = useAdminFetch<{ universities: University[] }>('/api/admin/universities');

  const toast = useToast();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<AssignableRole>('STUDENT');
  const [roleConfirmed, setRoleConfirmed] = useState(false);
  const [duration, setDuration] = useState<FreezeDurationKey>('d7');

  function openAction(action: PendingAction) {
    setPending(action);
    // Seeded from the account's CURRENT role so an approval that should not
    // change it is one click, and a change is deliberate.
    setRole((action.user.role as AssignableRole) ?? 'STUDENT');
    setRoleConfirmed(false);
    setDuration('d7');
  }

  /**
   * Runs a row action, then reloads.
   *
   * Reloading rather than patching the row locally: several of these actions
   * have side effects the client cannot infer - a freeze also revokes
   * sessions, an approval may change the role, a delete moves the account out
   * of the default filter - and guessing at them is how a table starts showing
   * a state the server does not hold.
   */
  async function runAction(reason: string) {
    if (!pending) return;
    setBusy(true);

    const { kind, user } = pending;

    try {
      const request: { method: string; body: Record<string, unknown> } =
        kind === 'delete'
          ? { method: 'DELETE', body: { reason, confirmNickname: user.nickname } }
          : kind === 'freeze'
            ? { method: 'PATCH', body: { op: 'freeze', reason, until: freezeUntilIso(duration) } }
            : kind === 'unfreeze'
              ? { method: 'PATCH', body: { op: 'unfreeze' } }
              : {
                  method: 'PATCH',
                  body: {
                    op: 'verification',
                    verificationStatus: kind === 'verify' ? 'VERIFIED' : 'REJECTED',
                    reason,
                    // The role is only sent with an approval; a rejection has
                    // no business changing what someone is.
                    ...(kind === 'verify'
                      ? { role, confirmPrivileged: isPrivilegedRole(role) ? roleConfirmed : undefined }
                      : {}),
                  },
                };

      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        toast(t(payload?.error ?? 'errors.generic'), 'error');
        return;
      }

      toast(t('admin.common.done'), 'success');
      setPending(null);
      reload();
    } catch {
      toast(t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const sort = params.get('sort') ?? 'createdAt';
  const order = (params.get('order') ?? 'desc') as 'asc' | 'desc';
  const onSort = (field: string) =>
    setParam({ sort: field, order: sort === field && order === 'desc' ? 'asc' : 'desc' });

  const activeFilters = ['role', 'accountStatus', 'verificationStatus', 'universityId', 'createdFrom', 'createdTo', 'q']
    .filter((key) => params.get(key));

  const select = 'input py-1.5 text-sm';

  return (
    <>
      <PageHeader
        title={t('admin.users.title')}
        description={t('admin.users.subtitle')}
        actions={
          data ? (
            <span className="text-2xs tabular-nums text-fg-muted">
              {t('admin.users.countLabel').replace('{total}', String(data.page.total))}
            </span>
          ) : null
        }
      />

      <div className="card mb-3 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">{t('admin.users.searchLabel')}</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t('admin.users.searchPlaceholder')}
              className="input py-1.5 pl-8 text-sm"
              type="search"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.university')}</span>
            <select
              value={params.get('universityId') ?? ''}
              onChange={(event) => setParam({ universityId: event.target.value || null })}
              className={select}
            >
              <option value="">{t('admin.common.all')}</option>
              {(uniData?.universities ?? []).map((uni) => (
                <option key={uni.id} value={uni.id}>
                  {uni.code}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.verification')}</span>
            <select
              value={params.get('verificationStatus') ?? ''}
              onChange={(event) => setParam({ verificationStatus: event.target.value || null })}
              className={select}
            >
              <option value="">{t('admin.common.all')}</option>
              {VERIFICATION_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.account')}</span>
            <select
              value={params.get('accountStatus') ?? ''}
              onChange={(event) => setParam({ accountStatus: event.target.value || null })}
              className={select}
            >
              <option value="">{t('admin.common.all')}</option>
              {ACCOUNT_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.role')}</span>
            <select
              value={params.get('role') ?? ''}
              onChange={(event) => setParam({ role: event.target.value || null })}
              className={select}
            >
              <option value="">{t('admin.common.all')}</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.from')}</span>
            <input
              type="date"
              value={params.get('createdFrom') ?? ''}
              onChange={(event) => setParam({ createdFrom: event.target.value || null })}
              className={select}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('admin.users.filters.to')}</span>
            <input
              type="date"
              value={params.get('createdTo') ?? ''}
              onChange={(event) => setParam({ createdTo: event.target.value || null })}
              className={select}
            />
          </label>

          {activeFilters.length > 0 && (
            <button
              type="button"
              onClick={() => router.replace('/admin/users', { scroll: false })}
              className="btn-ghost py-1.5"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t('admin.common.clearFilters')}
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        {/* The table is wide by nature. It scrolls inside this container so the
            page body never scrolls sideways on a laptop. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[70rem] border-collapse text-sm">
            <caption className="sr-only">{t('admin.users.title')}</caption>
            <thead className="border-b border-edge bg-surface-muted text-2xs uppercase tracking-wide">
              <tr>
                <SortHeader label={t('admin.users.columns.name')} field="fullName" sort={sort} order={order} onSort={onSort} />
                <SortHeader label={t('admin.users.columns.nickname')} field="nickname" sort={sort} order={order} onSort={onSort} />
                <SortHeader label={t('admin.users.columns.email')} field="email" sort={sort} order={order} onSort={onSort} />
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.users.columns.phone')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.users.columns.university')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.users.columns.graduation')}</th>
                <SortHeader label={t('admin.users.columns.role')} field="role" sort={sort} order={order} onSort={onSort} />
                <SortHeader label={t('admin.users.columns.account')} field="accountStatus" sort={sort} order={order} onSort={onSort} />
                <SortHeader label={t('admin.users.columns.verification')} field="verificationStatus" sort={sort} order={order} onSort={onSort} />
                <SortHeader label={t('admin.users.columns.created')} field="createdAt" sort={sort} order={order} onSort={onSort} />
                <SortHeader label={t('admin.users.columns.lastLogin')} field="lastLoginAt" sort={sort} order={order} onSort={onSort} />
                <SortHeader label={t('admin.users.columns.updated')} field="updatedAt" sort={sort} order={order} onSort={onSort} />
                <th scope="col" className="px-3 py-2 text-right font-medium text-fg-muted">
                  {t('admin.common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={13} className="p-0">
                    <TableSkeleton rows={8} cols={7} />
                  </td>
                </tr>
              )}

              {!loading && data?.users.length === 0 && (
                <tr>
                  <td colSpan={13}>
                    <EmptyState
                      title={t('admin.users.emptyTitle')}
                      hint={activeFilters.length > 0 ? t('admin.users.emptyFiltered') : t('admin.users.emptyHint')}
                    />
                  </td>
                </tr>
              )}

              {!loading &&
                data?.users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-edge last:border-0 hover:bg-surface-muted"
                  >
                    {/*
                      The row is not a click handler. A <Link> in the primary
                      cell keeps middle-click, ctrl-click and "copy link"
                      working, and gives keyboard users a real tab stop -
                      none of which a div with onClick provides.
                    */}
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/users/${user.id}`}
                        className="font-medium text-fg underline-offset-2 hover:underline"
                      >
                        {user.fullName}
                      </Link>
                      {user.deletedAt && (
                        <span className="ml-1.5 text-2xs text-danger-fg">
                          {t('admin.users.deletedMark')}
                        </span>
                      )}
                      <span className="mt-0.5 block font-mono text-2xs text-fg-subtle">{user.id}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-fg-muted">@{user.nickname}</td>
                    <td className="px-3 py-2 text-fg-muted">{user.email}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-2xs text-fg-muted">
                      {user.phone ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-fg-muted">
                      {user.university?.code ?? '—'}
                      {user.facultyLabel && (
                        <span className="mt-0.5 block text-2xs text-fg-subtle">{user.facultyLabel}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-fg-muted">
                      {user.graduationYear
                        ? `${user.graduationYear}-${String(user.graduationMonth ?? 1).padStart(2, '0')}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2"><StatusBadge kind="role" value={user.role} /></td>
                    <td className="px-3 py-2">
                      <StatusBadge kind="account" value={user.accountStatus} />
                      {/* The freeze EXPIRY is the part the status badge cannot
                          show, and it is what an operator actually needs to
                          know before acting on the row. */}
                      {user.freeze?.frozen && (
                        <span className="mt-0.5 block text-2xs text-fg-subtle">
                          {user.freeze.until
                            ? t('admin.users.frozenUntil', { date: formatDate(user.freeze.until) })
                            : t('admin.users.frozenIndefinitely')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2"><StatusBadge kind="verification" value={user.verificationStatus} /></td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-2xs text-fg-muted">{formatDateTime(user.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-2xs text-fg-muted">{formatDateTime(user.lastLoginAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-2xs text-fg-muted">{formatDate(user.updatedAt)}</td>

                    {/*
                      Row actions.
                      Every one of these is re-authorized server-side - PATCH
                      and DELETE on this resource are ADMIN-only via
                      withAdmin(request, 'ADMIN'). Hiding a button from a
                      moderator is a courtesy so the panel does not offer what
                      it cannot deliver; it is NOT the control.
                    */}
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {user.deletedAt ? (
                        <span className="text-2xs text-fg-subtle">{t('admin.users.deletedMark')}</span>
                      ) : (
                        <div className="inline-flex items-center gap-1">
                          {user.verificationStatus !== 'VERIFIED' && (
                            <button
                              type="button"
                              onClick={() => openAction({ kind: 'verify', user })}
                              title={t('admin.users.approve')}
                              aria-label={`${t('admin.users.approve')} @${user.nickname}`}
                              className="rounded-md p-1.5 text-fg-subtle transition hover:bg-verified-soft hover:text-verified"
                            >
                              <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}

                          {user.verificationStatus !== 'REJECTED' && (
                            <button
                              type="button"
                              onClick={() => openAction({ kind: 'reject', user })}
                              title={t('admin.users.reject')}
                              aria-label={`${t('admin.users.reject')} @${user.nickname}`}
                              className="rounded-md p-1.5 text-fg-subtle transition hover:bg-warn-soft hover:text-warn"
                            >
                              <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}

                          {user.freeze?.frozen ? (
                            <button
                              type="button"
                              onClick={() => openAction({ kind: 'unfreeze', user })}
                              title={t('admin.users.unfreeze')}
                              aria-label={`${t('admin.users.unfreeze')} @${user.nickname}`}
                              className="rounded-md p-1.5 text-accent transition hover:bg-accent-soft"
                            >
                              <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openAction({ kind: 'freeze', user })}
                              title={t('admin.users.freeze')}
                              aria-label={`${t('admin.users.freeze')} @${user.nickname}`}
                              className="rounded-md p-1.5 text-fg-subtle transition hover:bg-accent-soft hover:text-accent"
                            >
                              <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => openAction({ kind: 'delete', user })}
                            title={t('admin.users.actions.delete')}
                            aria-label={`${t('admin.users.actions.delete')} @${user.nickname}`}
                            className="rounded-md p-1.5 text-fg-subtle transition hover:bg-danger-soft hover:text-danger"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
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

      {/*
        One dialog instance for every row action, driven by `pending`.
        Rendering a dialog per row would mount hundreds of focus traps on a
        full page of results; this mounts one and gives it the current target.
      */}
      <ConfirmDialog
        open={pending !== null}
        busy={busy}
        title={
          pending?.kind === 'verify'
            ? t('admin.users.approveTitle')
            : pending?.kind === 'reject'
              ? t('admin.users.rejectTitle')
              : pending?.kind === 'freeze'
                ? t('admin.users.freezeTitle')
                : pending?.kind === 'unfreeze'
                  ? t('admin.users.unfreezeTitle')
                  : t('admin.users.actions.confirmDeleteTitle')
        }
        body={
          pending?.kind === 'verify'
            ? t('admin.users.approveBody')
            : pending?.kind === 'reject'
              ? t('admin.users.rejectBody')
              : pending?.kind === 'freeze'
                ? t('admin.users.freezeBody')
                : pending?.kind === 'unfreeze'
                  ? t('admin.users.unfreezeBody')
                  : t('admin.users.actions.confirmDeleteBody')
        }
        confirmLabel={
          pending?.kind === 'verify'
            ? t('admin.users.approve')
            : pending?.kind === 'reject'
              ? t('admin.users.reject')
              : pending?.kind === 'freeze'
                ? t('admin.users.freezeConfirm')
                : pending?.kind === 'unfreeze'
                  ? t('admin.users.unfreezeConfirm')
                  : t('admin.users.actions.delete')
        }
        tone={pending?.kind === 'verify' || pending?.kind === 'unfreeze' ? 'primary' : 'danger'}
        /* Unfreezing is the one action that needs no justification: it RESTORES
           access, so demanding a written reason to undo a mistake only makes
           the mistake likelier to persist. */
        requireReason={pending !== null && pending.kind !== 'unfreeze'}
        /* Deletion additionally requires typing the nickname, and the server
           re-checks that echo - a client that skips the dialog must not skip
           the safeguard. */
        typeToConfirm={pending?.kind === 'delete' ? pending.user.nickname : undefined}
        extraValid={
          // An approval that grants a privileged role is blocked until the
          // acknowledgement is ticked. Same rule server-side.
          pending?.kind !== 'verify' || !isPrivilegedRole(role) || roleConfirmed
        }
        extra={
          pending?.kind === 'verify' ? (
            <RoleSelect
              value={role}
              onChange={setRole}
              confirmed={roleConfirmed}
              onConfirmedChange={setRoleConfirmed}
            />
          ) : pending?.kind === 'freeze' ? (
            <FreezeDurationSelect value={duration} onChange={setDuration} />
          ) : undefined
        }
        onCancel={() => {
          if (busy) return;
          setPending(null);
        }}
        onConfirm={(reason) => void runAction(reason)}
      />
    </>
  );
}
