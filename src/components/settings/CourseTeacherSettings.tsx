'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Camera, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { AvailabilityGrid } from '@/components/mentors/AvailabilityGrid';
import { cellsToRules, rulesToCells } from '@/lib/mentors/schedule';
import type { CourseTeacherRecord } from '@/lib/firebase/repositories/users';
import { AVATAR_UPLOAD_MAX_SIDE, uploadImage } from '@/lib/media/browser-upload';

type Teacher = CourseTeacherRecord;
const emptyTeacher = (): Teacher => ({
  id: crypto.randomUUID(), fullName: '', specialization: '', bio: '', avatarUrl: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Baku', availability: [],
});

/** Course account owner manages each teacher's identity and weekly timetable here. */
export function CourseTeacherSettings() {
  const t = useT();
  const toast = useToast();
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedTeacher, setExpandedTeacher] = useState<string | null>(null);
  const [persistedIds, setPersistedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/mentors/me/course-teachers', { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('errors.generic');
        const body = await res.json();
        const records = Array.isArray(body.teachers) ? body.teachers as Teacher[] : [];
        setTeachers(records);
        setPersistedIds(new Set(records.map((teacher) => teacher.id)));
      })
      .catch((cause) => {
        if ((cause as Error).name !== 'AbortError') setError(cause instanceof Error ? cause.message : 'errors.generic');
      })
      .finally(() => setLoaded(true));
    return () => controller.abort();
  }, []);

  function changeTeacher(id: string, patch: Partial<Teacher>) {
    setTeachers((previous) => previous.map((teacher) => teacher.id === id ? { ...teacher, ...patch } : teacher));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/mentors/me/course-teachers', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teachers: teachers.map(({ avatarUrl: _avatarUrl, ...teacher }) => teacher) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'errors.generic');
      setTeachers(body.teachers);
      setPersistedIds(new Set((body.teachers as Teacher[]).map((teacher) => teacher.id)));
      toast.success(t('settings.courseTeachers.saved'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'errors.generic');
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(id: string, file: File) {
    try {
      const { avatarUrl } = await uploadImage<{ avatarUrl: string }>(
        `/api/mentors/me/course-teachers/${id}/avatar`, file, AVATAR_UPLOAD_MAX_SIDE,
      );
      changeTeacher(id, { avatarUrl });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'feed.image.errors.uploadFailed');
    }
  }

  function removeTeacher(id: string) {
    setTeachers((rows) => rows.filter((teacher) => teacher.id !== id));
    if (expandedTeacher === id) setExpandedTeacher(null);
  }

  if (!loaded) return <section className="card h-32 animate-pulse" aria-busy="true" />;

  return (
    <section className="card space-y-4 p-5" aria-labelledby="course-teachers-title">
      <div>
        <h2 id="course-teachers-title" className="text-base font-semibold text-fg">{t('settings.courseTeachers.title')}</h2>
        <p className="mt-1 text-sm text-fg-muted">{t('settings.courseTeachers.description')}</p>
      </div>

      {teachers.length === 0 && <p className="rounded-lg bg-surface-muted p-3 text-sm text-fg-muted">{t('settings.courseTeachers.empty')}</p>}
      <div className="space-y-4">
        {teachers.map((teacher) => (
          <article key={teacher.id} className="space-y-4 rounded-xl border border-edge p-4">
            <div className="flex items-center gap-3">
              <UserAvatar nickname={teacher.fullName || t('settings.courseTeachers.teacher')} src={teacher.avatarUrl} verified={false} size="lg" />
              <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={expandedTeacher === teacher.id} onClick={() => setExpandedTeacher((current) => current === teacher.id ? null : teacher.id)}>
                <span className="block truncate text-sm font-semibold text-fg">{teacher.fullName || t('settings.courseTeachers.teacher')}</span>
                <span className="block truncate text-xs text-fg-muted">{teacher.specialization || t('settings.courseTeachers.specialization')}</span>
              </button>
              {teachers.length > 2 && <button type="button" className="btn-ghost p-2 text-danger" aria-label={t('settings.courseTeachers.remove')} onClick={() => removeTeacher(teacher.id)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>}
            </div>
            {expandedTeacher === teacher.id && <div className="space-y-4">
                <label className={`btn-secondary w-fit px-2 py-1 text-xs ${persistedIds.has(teacher.id) ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                  <Camera className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />{t('settings.courseTeachers.picture')}
                  <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={!persistedIds.has(teacher.id)} onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAvatar(teacher.id, file);
                    event.currentTarget.value = '';
                  }} />
                </label>
              <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-fg-muted">{t('settings.courseTeachers.name')}
                  <input className="input py-2 text-sm" value={teacher.fullName} maxLength={120} onChange={(event) => changeTeacher(teacher.id, { fullName: event.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-muted">{t('settings.courseTeachers.specialization')}
                  <input className="input py-2 text-sm" value={teacher.specialization} maxLength={120} onChange={(event) => changeTeacher(teacher.id, { specialization: event.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-muted sm:col-span-2">{t('settings.courseTeachers.bio')}
                  <textarea className="input min-h-20 py-2 text-sm" value={teacher.bio} maxLength={2000} onChange={(event) => changeTeacher(teacher.id, { bio: event.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-muted">{t('settings.courseTeachers.timezone')}
                  <input className="input py-2 text-sm" value={teacher.timezone} maxLength={64} onChange={(event) => changeTeacher(teacher.id, { timezone: event.target.value })} placeholder="Asia/Baku" />
                </label>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-fg">{t('settings.courseTeachers.availability')}</h3>
                <AvailabilityGrid value={rulesToCells(teacher.availability ?? [])} onChange={(next) => setTeachers((previous) => previous.map((current) => current.id === teacher.id ? {
                  ...current,
                  availability: cellsToRules(typeof next === 'function' ? next(rulesToCells(current.availability ?? [])) : next),
                } : current))} />
              </div>
            </div>}
          </article>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary px-3 py-2 text-sm" disabled={teachers.length >= 30} onClick={() => {
          const teacher = emptyTeacher();
          setTeachers((rows) => [...rows, teacher]);
          setExpandedTeacher(teacher.id);
        }}>
          <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />{t('settings.courseTeachers.add')}
        </button>
        <button type="button" className="btn-primary px-3 py-2 text-sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="mr-1 inline h-4 w-4" aria-hidden="true" />}
          {t('settings.courseTeachers.save')}
        </button>
        <Link className="btn-ghost px-3 py-2 text-sm" href="/mentors/apply">{t('settings.courseTeachers.application')}</Link>
      </div>
      {error && <p role="alert" className="text-sm text-danger-fg">{t(error)}</p>}
    </section>
  );
}
