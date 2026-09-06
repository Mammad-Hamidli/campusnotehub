'use client';

import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import { ErrorState, StatusBadge, TableSkeleton, formatDateTime, useToast } from './primitives';

/**
 * The administrator's own profile.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS READS AND WRITES /api/me, NOT AN ADMIN ENDPOINT
 * ---------------------------------------------------------------------------
 * An admin editing their OWN headline is not an administrative act - it is the
 * same operation a student performs, on the same columns, with the same
 * authorization ("are you signed in as this person"). Routing it through
 * /api/admin/* would mean a second implementation of the field allow-list that
 * keeps `role` and `accountStatus` un-editable, and the copy is exactly where
 * a privilege-escalation bug would eventually appear.
 *
 * So this screen is admin CHROME around the ordinary self-service endpoint.
 * What is genuinely administrative - the tier badge, session state - is shown
 * read-only, because changing your own role is refused server-side anyway
 * (see the self-demotion guard in /api/admin/users/:userId).
 */

type Me = {
  id: string;
  fullName: string;
  nickname: string;
  email: string;
  headline: string | null;
  bio: string | null;
  role: string;
  accountStatus: string;
  verificationStatus: string;
  lastLoginAt: string | null;
  createdAt: string;
  university: { code: string; nameEn: string } | null;
};

export function AdminProfile() {
  const t = useT();
  const toast = useToast();

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ fullName: '', headline: '', bio: '' });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/me');
      if (!response.ok) {
        setError('errors.generic');
        return;
      }
      const { user } = await response.json();
      setMe(user);
      setForm({
        fullName: user.fullName ?? '',
        headline: user.headline ?? '',
        bio: user.bio ?? '',
      });
    } catch {
      setError('errors.generic');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName.trim(),
          headline: form.headline.trim(),
          bio: form.bio.trim(),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast(t(payload?.error ?? 'admin.profile.saveFailed'), 'error');
        return;
      }
      toast(t('admin.profile.saved'), 'success');
    } catch {
      toast(t('admin.profile.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title={t('admin.profile.title')} description={t('admin.profile.subtitle')} />
        <div className="card overflow-hidden">
          <TableSkeleton rows={5} cols={2} />
        </div>
      </>
    );
  }

  if (error || !me) {
    return (
      <>
        <PageHeader title={t('admin.profile.title')} />
        <ErrorState message={t(error ?? 'errors.generic')} onRetry={load} />
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('admin.profile.title')} description={t('admin.profile.subtitle')} />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <form onSubmit={save} className="card p-4">
          <h2 className="text-sm font-semibold text-fg">{t('admin.profile.account')}</h2>

          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="text-2xs font-medium text-fg-muted">
                {t('auth.register.fullName')}
              </span>
              <input
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                minLength={3}
                maxLength={120}
                required
                className="input mt-1 py-2 text-sm"
              />
            </label>

            <label className="block">
              <span className="text-2xs font-medium text-fg-muted">{t('profile.headline')}</span>
              <input
                value={form.headline}
                onChange={(e) => setForm({ ...form, headline: e.target.value })}
                maxLength={160}
                className="input mt-1 py-2 text-sm"
              />
            </label>

            <label className="block">
              <span className="text-2xs font-medium text-fg-muted">{t('profile.bio')}</span>
              <textarea
                value={form.bio}
                onChange={(e) => setForm({ ...form, bio: e.target.value })}
                maxLength={1000}
                rows={4}
                className="input mt-1 resize-y py-2 text-sm"
              />
            </label>
          </div>

          <div className="mt-5 flex justify-end border-t border-edge pt-4">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('admin.profile.save')}
            </button>
          </div>
        </form>

        {/* Read-only. Nothing in this panel can change your own role or status:
            the server refuses self-demotion outright, because it is the only
            single-actor path to locking the platform out of its own admin. */}
        <aside className="card h-fit p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <ShieldCheck className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
            {t('admin.profile.tier')}
          </h2>

          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="text-2xs text-fg-subtle">{t('admin.profile.signedInAs')}</dt>
              <dd className="mt-0.5 font-medium text-fg">@{me.nickname}</dd>
            </div>
            <div>
              <dt className="text-2xs text-fg-subtle">{t('admin.users.columns.role')}</dt>
              <dd className="mt-1">
                <StatusBadge kind="role" value={me.role} />
              </dd>
            </div>
            <div>
              <dt className="text-2xs text-fg-subtle">{t('admin.users.columns.account')}</dt>
              <dd className="mt-1">
                <StatusBadge kind="account" value={me.accountStatus} />
              </dd>
            </div>
            <div>
              <dt className="text-2xs text-fg-subtle">{t('auth.register.email')}</dt>
              <dd className="mt-0.5 break-all text-xs text-fg-muted">{me.email}</dd>
            </div>
            {me.university && (
              <div>
                <dt className="text-2xs text-fg-subtle">{t('auth.register.university')}</dt>
                <dd className="mt-0.5 text-xs text-fg-muted">{me.university.code}</dd>
              </div>
            )}
            <div>
              <dt className="text-2xs text-fg-subtle">{t('admin.profile.lastLogin')}</dt>
              <dd className="mt-0.5 tabular text-xs text-fg-muted">
                {formatDateTime(me.lastLoginAt)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs text-fg-subtle">{t('admin.profile.memberSince')}</dt>
              <dd className="mt-0.5 tabular text-xs text-fg-muted">
                {formatDateTime(me.createdAt)}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </>
  );
}
