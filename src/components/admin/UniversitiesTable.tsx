'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, ToggleLeft, ToggleRight } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  TableSkeleton,
  useAdminFetch,
  useToast,
} from './primitives';

type University = {
  id: string;
  code: string;
  nameAz: string;
  nameEn: string;
  nameRu: string;
  city: string;
  emailDomains: string[];
  isActive: boolean;
  createdAt: string;
  _count: { users: number; faculties: number };
};

/**
 * Institution management.
 *
 * There is no delete button, and that is a schema decision rather than an
 * omission: User.universityId is onDelete: SetNull, so removing a row would
 * silently detach every student from the institution their verification was
 * granted against. Deactivating is the reversible equivalent - the register
 * route already filters on isActive - and it keeps history readable.
 */
export function UniversitiesTable({ canManage }: { canManage: boolean }) {
  const t = useT();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminFetch<{ universities: University[] }>(
    '/api/admin/universities',
  );
  const [toggling, setToggling] = useState<University | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    code: '', nameAz: '', nameEn: '', nameRu: '', city: '', emailDomains: '',
  });

  async function toggleActive(university: University) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/universities/${university.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: !university.isActive }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return toast(t(body.error ?? 'errors.generic'), 'error');
      toast(t('admin.universities.toggled'));
      setToggling(null);
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch('/api/admin/universities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...form,
          emailDomains: form.emailDomains.split(',').map((d) => d.trim()).filter(Boolean),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return toast(t(body.error ?? 'errors.validationFailed'), 'error');
      toast(t('admin.universities.created'));
      setCreating(false);
      setForm({ code: '', nameAz: '', nameEn: '', nameRu: '', city: '', emailDomains: '' });
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('admin.universities.title')}
        description={t('admin.universities.subtitle')}
        actions={
          canManage ? (
            <button type="button" className="btn-primary" onClick={() => setCreating((open) => !open)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('admin.universities.add')}
            </button>
          ) : null
        }
      />

      {/*
        A row created here is immediately usable by the registration API, but
        the signup dropdown is still built from the static list in
        src/lib/universities.ts. Saying so here prevents an admin adding an
        institution and then reporting the dropdown as broken.
      */}
      <p className="mb-3 rounded-lg border border-edge bg-surface-muted p-2.5 text-2xs leading-relaxed text-fg-muted">
        {t('admin.universities.dropdownNote')}
      </p>

      {creating && canManage && (
        <form onSubmit={create} className="card mb-3 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
          {([
            ['code', 'admin.universities.fields.code'],
            ['nameAz', 'admin.universities.fields.nameAz'],
            ['nameEn', 'admin.universities.fields.nameEn'],
            ['nameRu', 'admin.universities.fields.nameRu'],
            ['city', 'admin.universities.fields.city'],
            ['emailDomains', 'admin.universities.fields.domains'],
          ] as const).map(([key, labelKey]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-2xs font-medium text-fg-muted">{t(labelKey)}</span>
              <input
                required={key !== 'emailDomains'}
                value={form[key]}
                onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
                className="input py-1.5 text-sm"
              />
            </label>
          ))}
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('admin.universities.save')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              {t('admin.common.cancel')}
            </button>
          </div>
        </form>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <caption className="sr-only">{t('admin.universities.title')}</caption>
            <thead className="border-b border-edge bg-surface-muted text-2xs uppercase tracking-wide">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.universities.columns.name')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.universities.columns.id')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.universities.columns.domains')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.universities.columns.status')}</th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.universities.columns.users')}</th>
                {canManage && <th scope="col" className="px-3 py-2 text-left font-medium text-fg-muted">{t('admin.common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="p-0"><TableSkeleton rows={6} cols={5} /></td></tr>}

              {!loading && data?.universities.length === 0 && (
                <tr><td colSpan={6}><EmptyState title={t('admin.universities.empty')} /></td></tr>
              )}

              {!loading && data?.universities.map((uni) => (
                <tr key={uni.id} className="border-b border-edge last:border-0 hover:bg-surface-muted">
                  <td className="px-3 py-2">
                    <span className="font-medium text-fg">{uni.code}</span>
                    <span className="mt-0.5 block text-2xs text-fg-muted">{uni.nameEn}</span>
                    <span className="text-2xs text-fg-subtle">{uni.city}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs text-fg-subtle">{uni.id}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {uni.emailDomains.length === 0
                        ? <span className="text-2xs text-fg-subtle">—</span>
                        : uni.emailDomains.map((domain) => <Badge key={domain}>{domain}</Badge>)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {uni.isActive
                      ? <Badge tone="positive">{t('admin.universities.active')}</Badge>
                      : <Badge tone="neutral">{t('admin.universities.inactive')}</Badge>}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/users?universityId=${uni.id}`}
                      className="tabular-nums text-fg underline-offset-2 hover:underline"
                    >
                      {uni._count.users}
                    </Link>
                    <span className="mt-0.5 block text-2xs text-fg-subtle">
                      {t('admin.universities.faculties').replace('{n}', String(uni._count.faculties))}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-3 py-2">
                      <button type="button" className="btn-secondary px-2 py-1 text-2xs" onClick={() => setToggling(uni)}>
                        {uni.isActive
                          ? <ToggleRight className="h-3.5 w-3.5" aria-hidden="true" />
                          : <ToggleLeft className="h-3.5 w-3.5" aria-hidden="true" />}
                        {uni.isActive ? t('admin.universities.deactivate') : t('admin.universities.activate')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <ErrorState message={t(error)} onRetry={reload} />}
      </div>

      {toggling && (
        <ConfirmDialog
          open
          title={toggling.isActive ? t('admin.universities.confirmDeactivate') : t('admin.universities.confirmActivate')}
          body={
            toggling.isActive
              ? t('admin.universities.confirmDeactivateBody').replace('{code}', toggling.code)
              : t('admin.universities.confirmActivateBody').replace('{code}', toggling.code)
          }
          confirmLabel={toggling.isActive ? t('admin.universities.deactivate') : t('admin.universities.activate')}
          tone={toggling.isActive ? 'danger' : 'primary'}
          busy={busy}
          onCancel={() => setToggling(null)}
          onConfirm={() => void toggleActive(toggling)}
        />
      )}
    </>
  );
}
