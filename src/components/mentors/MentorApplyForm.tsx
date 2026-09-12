'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * PocketMentor application form (POST /api/mentors/apply).
 *
 * Shows the applicant's current state first - pending, approved, rejected,
 * or not yet eligible - so nobody fills in the whole form only to be told at
 * the end that they already applied.
 */

/** Mirrors MentorIndustry in src/lib/enums.ts; the server re-validates. */
const INDUSTRIES = ['IT', 'MARKETING', 'LAW', 'ENGINEERING', 'FINANCE', 'MEDICINE', 'EDUCATION', 'DESIGN', 'OTHER'];
const LANGUAGES = ['az', 'en', 'ru', 'tr'] as const;
const SESSION_LENGTHS = [30, 45, 60, 90];

type Experience = { company: string; role: string; years: string };
type Education = { institution: string; degree: string; field: string; graduationYear: string };

type Status = {
  application: { status: 'PENDING' | 'APPROVED' | 'REJECTED'; rejectionReason: string | null } | null;
  isMentor: boolean;
  canApply: boolean;
};

const emptyExperience = (): Experience => ({ company: '', role: '', years: '' });
const emptyEducation = (): Education => ({ institution: '', degree: '', field: '', graduationYear: '' });

export function MentorApplyForm() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [industry, setIndustry] = useState('IT');
  const [expertise, setExpertise] = useState('');
  const [experiences, setExperiences] = useState<Experience[]>([emptyExperience()]);
  const [education, setEducation] = useState<Education[]>([]);
  const [languages, setLanguages] = useState<string[]>(['az']);
  const [rate, setRate] = useState('0');
  const [sessionMinutes, setSessionMinutes] = useState(60);
  const [linkedinUrl, setLinkedinUrl] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/mentors/apply', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setStatus(await response.json());
      })
      .catch((cause) => {
        if ((cause as Error)?.name !== 'AbortError') setLoadError(true);
      });
    return () => controller.abort();
  }, []);

  function updateExperience(index: number, patch: Partial<Experience>) {
    setExperiences((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function updateEducation(index: number, patch: Partial<Education>) {
    setEducation((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function toggleLanguage(code: string) {
    setLanguages((current) =>
      current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const body = {
      headline,
      bio,
      industry,
      expertise: expertise
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      experiences: experiences.map((e) => ({ company: e.company, role: e.role, years: Number(e.years || 0) })),
      education: education
        .filter((e) => e.institution.trim() || e.degree.trim())
        .map((e) => ({
          institution: e.institution,
          degree: e.degree,
          field: e.field || null,
          graduationYear: e.graduationYear ? Number(e.graduationYear) : null,
        })),
      languages,
      hourlyRateMinor: Math.round(Number(rate.replace(',', '.') || 0) * 100),
      sessionMinutes,
      linkedinUrl: linkedinUrl.trim() || null,
    };

    try {
      const response = await fetch('/api/mentors/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error ?? 'errors.generic');
        setFieldErrors(payload.fields ?? {});
        return;
      }
      setStatus((s) => ({
        isMentor: false,
        canApply: true,
        ...(s ?? {}),
        application: { status: 'PENDING', rejectionReason: null },
      }));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setError('errors.network');
    } finally {
      setBusy(false);
    }
  }

  const invalid = (key: string) => (fieldErrors[key]?.length ? 'border-danger' : '');
  const field = 'input py-2 text-sm';

  const shell = (children: React.ReactNode) => (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-xl font-bold tracking-tight text-fg">{t('mentors.apply.title')}</h1>
      <p className="mt-1 text-sm text-fg-muted">{t('mentors.apply.subtitle')}</p>
      <div className="mt-5">{children}</div>
    </div>
  );

  if (loadError) {
    return shell(<p className="card p-6 text-sm text-fg-muted">{t('errors.generic')}</p>);
  }
  if (!status) {
    return shell(<div className="card h-64 animate-pulse" aria-busy="true" />);
  }
  if (status.isMentor || status.application?.status === 'APPROVED') {
    return shell(
      <div className="card p-6">
        <p className="text-sm text-fg">{t('mentors.apply.approved')}</p>
        <Link href="/mentors" className="btn-secondary mt-3 px-3 py-1.5 text-sm">
          {t('mentors.title')}
        </Link>
      </div>,
    );
  }
  if (status.application?.status === 'PENDING') {
    return shell(<p className="card p-6 text-sm text-fg">{t('mentors.apply.pending')}</p>);
  }
  if (!status.canApply) {
    return shell(<p className="card border-warn/30 bg-warn-soft p-6 text-sm text-warn-fg">{t('mentors.apply.verifyFirst')}</p>);
  }

  return shell(
    <form onSubmit={submit} className="space-y-4">
      {status.application?.status === 'REJECTED' && (
        <p className="card border-warn/30 bg-warn-soft p-3 text-sm text-warn-fg">
          {t('mentors.apply.rejected')}
          {status.application.rejectionReason ? ` — ${status.application.rejectionReason}` : ''}
        </p>
      )}

      <section className="card space-y-3 p-4">
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.apply.headline')}</span>
          <input className={`${field} ${invalid('headline')}`} value={headline} maxLength={160} onChange={(e) => setHeadline(e.target.value)} required minLength={10} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.apply.bio')}</span>
          <textarea className={`${field} min-h-32 ${invalid('bio')}`} value={bio} maxLength={4000} onChange={(e) => setBio(e.target.value)} required minLength={50} />
          <span className="text-2xs text-fg-subtle">{t('mentors.apply.bioHint')}</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('mentors.industry')}</span>
            <select className={field} value={industry} onChange={(e) => setIndustry(e.target.value)}>
              {INDUSTRIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-fg-muted">{t('mentors.apply.expertise')}</span>
            <input className={`${field} ${invalid('expertise')}`} value={expertise} onChange={(e) => setExpertise(e.target.value)} placeholder={t('mentors.apply.expertiseHint')} required />
          </label>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">{t('mentors.apply.experience')}</h2>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={experiences.length >= 10} onClick={() => setExperiences((rows) => [...rows, emptyExperience()])}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('mentors.apply.addExperience')}
          </button>
        </div>
        {experiences.map((row, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem_auto]">
            <input className={`${field} ${invalid('experiences')}`} placeholder={t('mentors.apply.company')} value={row.company} onChange={(e) => updateExperience(index, { company: e.target.value })} required minLength={2} />
            <input className={`${field} ${invalid('experiences')}`} placeholder={t('mentors.apply.role')} value={row.role} onChange={(e) => updateExperience(index, { role: e.target.value })} required minLength={2} />
            <input className={`${field} ${invalid('experiences')}`} type="number" min={0} max={60} step="0.5" placeholder={t('mentors.apply.years')} value={row.years} onChange={(e) => updateExperience(index, { years: e.target.value })} required />
            <button type="button" aria-label={t('mentors.apply.remove')} className="btn-secondary px-2 py-1" disabled={experiences.length === 1} onClick={() => setExperiences((rows) => rows.filter((_, i) => i !== index))}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ))}
      </section>

      <section className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">{t('mentors.apply.education')}</h2>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={education.length >= 5} onClick={() => setEducation((rows) => [...rows, emptyEducation()])}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('mentors.apply.addEducation')}
          </button>
        </div>
        {education.length === 0 && <p className="text-2xs text-fg-subtle">{t('mentors.apply.educationHint')}</p>}
        {education.map((row, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_6rem_auto]">
            <input className={field} placeholder={t('mentors.apply.institution')} value={row.institution} onChange={(e) => updateEducation(index, { institution: e.target.value })} required minLength={2} />
            <input className={field} placeholder={t('mentors.apply.degree')} value={row.degree} onChange={(e) => updateEducation(index, { degree: e.target.value })} required minLength={2} />
            <input className={field} placeholder={t('mentors.apply.field')} value={row.field} onChange={(e) => updateEducation(index, { field: e.target.value })} />
            <input className={field} type="number" min={1950} max={2100} placeholder={t('mentors.apply.year')} value={row.graduationYear} onChange={(e) => updateEducation(index, { graduationYear: e.target.value })} />
            <button type="button" aria-label={t('mentors.apply.remove')} className="btn-secondary px-2 py-1" onClick={() => setEducation((rows) => rows.filter((_, i) => i !== index))}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ))}
      </section>

      <section className="card grid gap-3 p-4 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-2xs font-medium text-fg-muted">{t('mentors.apply.languages')}</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {LANGUAGES.map((code) => (
              <label key={code} className="flex items-center gap-1.5 text-sm text-fg">
                <input type="checkbox" checked={languages.includes(code)} onChange={() => toggleLanguage(code)} />
                {code.toUpperCase()}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.apply.rate')}</span>
          <input className={`${field} ${invalid('hourlyRateMinor')}`} type="number" min={0} max={500} step="0.5" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.apply.sessionLength')}</span>
          <select className={field} value={sessionMinutes} onChange={(e) => setSessionMinutes(Number(e.target.value))}>
            {SESSION_LENGTHS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t('mentors.apply.minutes', { minutes })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('mentors.apply.linkedin')}</span>
          <input className={`${field} ${invalid('linkedinUrl')}`} type="url" value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} placeholder="https://linkedin.com/in/…" />
        </label>
      </section>

      {error && (
        <p role="alert" className="text-sm text-danger-fg">
          {t(error)}
          {Object.keys(fieldErrors).length > 0 && ` (${Object.keys(fieldErrors).join(', ')})`}
        </p>
      )}

      <button type="submit" disabled={busy || languages.length === 0} className="btn-primary px-4 py-2 text-sm">
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {t('mentors.apply.submit')}
      </button>
    </form>,
  );
}
