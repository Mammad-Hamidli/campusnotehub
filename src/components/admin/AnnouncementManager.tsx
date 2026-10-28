'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { ImagePlus, Megaphone, Pencil, Plus, Trash2, X } from 'lucide-react';
import { PageHeader } from './AdminShell';
import { EmptyState, ErrorState, useAdminFetch } from './primitives';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useConfirm, useToast } from '@/components/ui/Feedback';
import { FEED_UPLOAD_MAX_SIDE, uploadImage } from '@/lib/media/browser-upload';

type Accent = 'violet' | 'blue' | 'amber' | 'rose' | 'emerald';
type Announcement = {
  id: string; title: string; body: string; imageUrl: string | null; actionLabel: string | null;
  actionUrl: string | null; accent: Accent; isActive: boolean; startsAt: string | null; endsAt: string | null;
  createdAt: string; updatedAt: string;
};
type Draft = Omit<Announcement, 'id' | 'createdAt' | 'updatedAt'>;
type TextField = 'title' | 'actionLabel' | 'actionUrl' | 'startsAt' | 'endsAt';
const blank: Draft = { title: '', body: '', imageUrl: null, actionLabel: null, actionUrl: null, accent: 'violet', isActive: false, startsAt: null, endsAt: null };
const previewColors: Record<Accent, string> = {
  violet: 'from-violet-700 via-fuchsia-600 to-rose-500', blue: 'from-blue-700 via-cyan-600 to-teal-400',
  amber: 'from-amber-600 via-orange-500 to-rose-500', rose: 'from-rose-700 via-pink-600 to-violet-500',
  emerald: 'from-emerald-700 via-teal-600 to-cyan-500',
};
// datetime-local shows and returns WALL-CLOCK time; save() reads it back with
// new Date(local). Rendering toISOString() (UTC) here shifted every edited
// schedule by the moderator's UTC offset.
const localDate = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function AnnouncementManager() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useAdminFetch<{ announcements: Announcement[] }>('/api/admin/announcements');
  const [draft, setDraft] = useState<Draft>(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function edit(item: Announcement) {
    setEditingId(item.id);
    setDraft({ title: item.title, body: item.body, imageUrl: item.imageUrl, actionLabel: item.actionLabel, actionUrl: item.actionUrl, accent: item.accent, isActive: item.isActive, startsAt: item.startsAt, endsAt: item.endsAt });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() { setDraft(blank); setEditingId(null); }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setBusy(true);
    try {
      // Shrunk in the browser first: Vercel drops request bodies over 4.5 MB.
      const { imageUrl } = await uploadImage<{ imageUrl: string }>('/api/admin/announcements/image', file, FEED_UPLOAD_MAX_SIDE);
      setDraft((current) => ({ ...current, imageUrl }));
      toast.success(t('admin.announcements.imageUploaded'));
    } catch (cause) { toast.error(t(cause instanceof Error ? cause.message : 'errors.generic')); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const payload = { ...draft, startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null, endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null };
    try {
      const response = await fetch(editingId ? `/api/admin/announcements/${editingId}` : '/api/admin/announcements', {
        method: editingId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'errors.generic');
      toast.success(t(editingId ? 'admin.announcements.updated' : 'admin.announcements.created'));
      reset(); reload();
    } catch (cause) { toast.error(t(cause instanceof Error ? cause.message : 'errors.generic')); }
    finally { setBusy(false); }
  }

  async function remove(item: Announcement) {
    if (!(await confirm({ title: t('admin.announcements.delete'), body: t('admin.announcements.confirmDelete'), confirmLabel: t('admin.announcements.delete'), tone: 'danger' }))) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/announcements/${item.id}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'errors.generic');
      toast.success(t('admin.announcements.deleted')); reload();
      if (editingId === item.id) reset();
    } catch (cause) { toast.error(t(cause instanceof Error ? cause.message : 'errors.generic')); }
    finally { setBusy(false); }
  }

  const fieldClass = 'mt-1.5 w-full rounded-xl border border-edge bg-canvas px-3 py-2.5 text-sm text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20';
  const input = (label: string, field: TextField, props: { type?: string; maxLength?: number; placeholder?: string } = {}) => (
    <label className="block text-xs font-semibold text-fg-muted">{label}
      <input className={fieldClass} type={props.type ?? 'text'} maxLength={props.maxLength} placeholder={props.placeholder} value={field === 'startsAt' || field === 'endsAt' ? localDate(draft[field] as string | null) : (draft[field] as string | null) ?? ''}
        onChange={(event) => setDraft((current) => ({ ...current, [field]: props.type === 'datetime-local' ? event.target.value || null : event.target.value || (field === 'actionLabel' || field === 'actionUrl' ? null : '') } as Draft))} />
    </label>
  );

  return <>
    <PageHeader title={t('admin.announcements.title')} description={t('admin.announcements.description')} />
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,.8fr)]">
      <form onSubmit={save} className="card space-y-4 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-fg">{t(editingId ? 'admin.announcements.editTitle' : 'admin.announcements.newTitle')}</h2>
          {editingId && <button type="button" onClick={reset} className="btn-ghost px-2 py-1"><X className="mr-1 inline h-3.5 w-3.5" />{t('admin.announcements.cancelEdit')}</button>}
        </div>
        {input(t('admin.announcements.fields.title'), 'title', { maxLength: 100 })}
        <label className="block text-xs font-semibold text-fg-muted">{t('admin.announcements.fields.body')}
          <textarea className={`${fieldClass} resize-y`} value={draft.body} maxLength={600} rows={5} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} />
          <span className="mt-1 block text-right text-2xs font-normal">{draft.body.length}/600</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {input(t('admin.announcements.fields.actionLabel'), 'actionLabel', { maxLength: 40 })}
          {input(t('admin.announcements.fields.actionUrl'), 'actionUrl', { placeholder: '/notes or https://…', maxLength: 500 })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {input(t('admin.announcements.fields.startsAt'), 'startsAt', { type: 'datetime-local' })}
          {input(t('admin.announcements.fields.endsAt'), 'endsAt', { type: 'datetime-local' })}
        </div>
        <label className="block text-xs font-semibold text-fg-muted">{t('admin.announcements.fields.accent')}
          <select className={fieldClass} value={draft.accent} onChange={(event) => setDraft((current) => ({ ...current, accent: event.target.value as Accent }))}>
            {(['violet', 'blue', 'amber', 'rose', 'emerald'] as Accent[]).map((accent) => <option key={accent} value={accent}>{t(`admin.announcements.accents.${accent}`)}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <label className="btn-secondary cursor-pointer px-3 py-2"><ImagePlus className="mr-1.5 inline h-4 w-4" />{t('admin.announcements.fields.image')}
            <input type="file" accept="image/*" className="sr-only" onChange={(event) => void upload(event)} disabled={busy} />
          </label>
          {draft.imageUrl && <button type="button" className="text-xs font-semibold text-danger-fg" onClick={() => setDraft((current) => ({ ...current, imageUrl: null }))}>{t('admin.announcements.removeImage')}</button>}
          <label className="ml-auto inline-flex items-center gap-2 text-xs font-semibold text-fg"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))} />{t('admin.announcements.fields.active')}</label>
        </div>
        {draft.imageUrl && <div className="overflow-hidden rounded-xl border border-edge"><img src={draft.imageUrl} alt="" className="max-h-44 w-full object-cover" /></div>}
        <button type="submit" disabled={busy || !draft.title.trim() || !draft.body.trim()} className="btn-primary px-4 py-2.5 disabled:opacity-50">{busy ? t('admin.announcements.saving') : editingId ? t('admin.announcements.saveChanges') : <><Plus className="mr-1 inline h-4 w-4" />{t('admin.announcements.create')}</>}</button>
      </form>

      <div className="space-y-3 xl:sticky xl:top-5">
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-fg-subtle">{t('admin.announcements.preview')}</h2>
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-r ${previewColors[draft.accent]} p-4 text-white shadow-raised`}>
            <div className="flex items-start gap-3">
              {draft.imageUrl ? <img src={draft.imageUrl} alt="" className="h-16 w-16 rounded-xl object-cover ring-1 ring-white/30" /> : <span className="rounded-xl bg-white/15 p-3"><Megaphone className="h-5 w-5" /></span>}
              <div><p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-white/75">{t('dashboard.announcement.eyebrow')}</p><p className="mt-1 text-lg font-black tracking-tight">{draft.title || t('admin.announcements.previewTitle')}</p><p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-white/90">{draft.body || t('admin.announcements.previewBody')}</p>
                {draft.actionLabel && <span className="mt-3 inline-flex rounded-full bg-white px-3 py-2 text-xs font-bold text-slate-950">{draft.actionLabel}</span>}
              </div>
            </div>
          </div>
        </section>
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-edge px-4 py-3"><h2 className="text-sm font-bold text-fg">{t('admin.announcements.listTitle')}</h2><button type="button" onClick={reload} className="btn-ghost px-2 py-1">{t('admin.common.retry')}</button></div>
          {error ? <ErrorState message={t(error)} onRetry={reload} /> : loading ? <div className="space-y-3 p-4"><div className="h-14 animate-pulse rounded-lg bg-surface-muted" /><div className="h-14 animate-pulse rounded-lg bg-surface-muted" /></div> : data?.announcements.length ? <ul className="divide-y divide-edge">{data.announcements.map((item) => <li key={item.id} className="flex items-center gap-3 p-3.5">
            {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-11 w-11 rounded-lg object-cover" /> : <span className={`h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br ${previewColors[item.accent]}`} />}
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-fg">{item.title}</p><p className="text-2xs text-fg-muted">{item.isActive ? t('admin.announcements.active') : t('admin.announcements.inactive')}</p></div>
            <button type="button" onClick={() => edit(item)} aria-label={t('admin.announcements.edit')} className="btn-ghost h-9 w-9 p-0"><Pencil className="mx-auto h-4 w-4" /></button>
            <button type="button" onClick={() => void remove(item)} aria-label={t('admin.announcements.delete')} disabled={busy} className="btn-ghost h-9 w-9 p-0 text-danger-fg"><Trash2 className="mx-auto h-4 w-4" /></button>
          </li>)}</ul> : <EmptyState title={t('admin.announcements.empty')} hint={t('admin.announcements.emptyHint')} />}
        </section>
      </div>
    </div>
  </>;
}
