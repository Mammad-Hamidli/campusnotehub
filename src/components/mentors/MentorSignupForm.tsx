'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { ProfileFields } from '@/components/register/ProfileFields';
import { ErrorSummary } from '@/components/register/ErrorSummary';
import {
  EMPTY_PROFILE,
  collectFingerprint,
  fieldErrorsFrom,
  validateProfile,
  type ProfileErrors,
  type ProfileForm,
} from '@/components/register/types';
import { normalizeAzPhone } from '@/lib/auth/phone';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';

/**
 * Mentor signup at /mentors/join.
 *
 * The student form's fields and rules (ProfileFields, validateProfile), with
 * the university optional, posted to POST /api/auth/register/mentor. The
 * account that comes back is an ordinary user document with role MENTOR; the
 * mentor PROFILE - headline, experience, availability - is the application
 * the mentor panel asks for next, and a moderator reviews it before anything
 * is listed.
 *
 * No quick login here: a Google sign-up creates a STUDENT account finished at
 * /onboarding, so offering it on this page would put mentors in the wrong
 * role. Someone who already has an account signs in and applies at
 * /mentors/apply instead.
 */
export function MentorSignupForm() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();

  const [form, setForm] = useState<ProfileForm>(EMPTY_PROFILE);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [showSummary, setShowSummary] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | undefined>();
  const [mentorType, setMentorType] = useState<'INDIVIDUAL' | 'COURSE' | ''>('');
  const [step, setStep] = useState<'select' | 'details'>('select');
  const [courseEmail, setCourseEmail] = useState('');
  const [teacherCount, setTeacherCount] = useState('2');
  // Guards a double press creating (or 409-ing on) a second account.
  const submittedRef = useRef(false);

  useEffect(() => {
    void collectFingerprint().then(setFingerprint);
  }, []);

  function update(patch: Partial<ProfileForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch)) delete next[key as keyof ProfileForm];
      if (Object.keys(next).length === 0) setShowSummary(false);
      return next;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || submittedRef.current) return;

    const submittedForm = mentorType === 'COURSE' ? { ...form, email: courseEmail } : form;
    const found = validateProfile(submittedForm, {
      requirePassword: true,
      requireEmail: mentorType !== 'COURSE',
      requirePhone: true,
      requireUniversity: false,
      organizationName: mentorType === 'COURSE',
    });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setShowSummary(true);
      return;
    }

    if (!mentorType || (mentorType === 'COURSE' && !courseEmail.trim())) {
      setFormError(!mentorType ? 'mentors.join.typeRequired' : 'mentors.join.courseEmailRequired');
      return;
    }
    if (mentorType === 'COURSE' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(courseEmail.trim())) {
      setFormError('mentors.join.courseEmailInvalid');
      return;
    }
    if (mentorType === 'COURSE' && (!/^\d+$/.test(teacherCount) || Number(teacherCount) < 2 || Number(teacherCount) > 30)) {
      setFormError('mentors.join.teacherCountInvalid');
      return;
    }

    setShowSummary(false);
    setSubmitting(true);
    setFormError(null);

    try {
      const res = await fetch('/api/auth/register/mentor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName.trim().replace(/\s+/g, ' '),
          nickname: form.nickname.trim(),
          // Left out rather than sent empty: '' is not a university code.
          ...(mentorType !== 'COURSE' && form.universityId ? { universityId: form.universityId } : {}),
          email: (mentorType === 'COURSE' ? courseEmail : form.email).trim().toLowerCase(),
          // E.164; validateProfile() has already refused anything unparseable.
          phone: normalizeAzPhone(form.phone) ?? '',
          password: form.password,
          locale: document.documentElement.lang || 'az',
          acceptTerms: form.acceptTerms,
          deviceFingerprint: fingerprint,
          mentorType,
          ...(mentorType === 'COURSE' ? { courseEmail: courseEmail.trim().toLowerCase(), teacherCount: Number(teacherCount) } : {}),
        }),
      });

      if (res.status === 403) {
        setBlocked(true);
        return;
      }

      const body = await res.json().catch(() => ({}));

      // 400 and 409 share the `fields` shape - see RegisterForm.
      if (res.status === 409 || res.status === 400) {
        const fieldErrors = fieldErrorsFrom(body);
        if (mentorType === 'COURSE' && fieldErrors.email) {
          setFormError(fieldErrors.email);
          return;
        }
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          setShowSummary(true);
          return;
        }
        if (res.status === 409) {
          setFormError(typeof body.error === 'string' ? body.error : 'auth.errors.credentialsUnavailable');
          return;
        }
      }

      if (!res.ok) {
        setFormError(res.status === 429 ? 'errors.rateLimited' : res.status === 400 ? 'errors.validationFailed' : typeof body.error === 'string' && body.error === 'mentors.join.paymentUnavailable' ? body.error : 'errors.generic');
        return;
      }

      submittedRef.current = true;
      toast.success(t('register.created'));
      const next = typeof body.next?.href === 'string' && body.next.href.startsWith('/') ? body.next.href : null;
      router.push(next ?? MENTOR_DASHBOARD_PATH);
    } catch {
      setFormError('errors.generic');
    } finally {
      setSubmitting(false);
    }
  }

  if (blocked) {
    return (
      <div className="mx-auto max-w-md animate-rise text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-soft">
          <ShieldAlert className="h-7 w-7 text-danger" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-xl font-bold tracking-tight text-fg">{t('register.blocked.title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t('verification.failure.generic')}</p>
      </div>
    );
  }

  if (step === 'select') {
    return (
      <div className="mx-auto grid w-full max-w-lg gap-4 sm:grid-cols-2" aria-label={t('mentors.join.chooseType')}>
        {(['INDIVIDUAL', 'COURSE'] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => {
              if (mentorType !== type) {
                setCourseEmail('');
                update({ email: '' });
              }
              setMentorType(type);
              setFormError(null);
              setStep('details');
            }}
            className="card flex min-h-44 flex-col items-center justify-center gap-3 p-6 text-center transition hover:border-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <GraduationCap className="h-8 w-8 text-accent" aria-hidden="true" />
            <span className="text-lg font-semibold text-fg">{t(type === 'INDIVIDUAL' ? 'mentors.join.individual' : 'mentors.join.course')}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg animate-rise">
      <p className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-accent">
        <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
        {t('mentors.join.badge')}
      </p>
      <h1 className="mt-3 text-balance text-2xl font-bold tracking-tight text-fg">{t('mentors.join.title')}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t('mentors.join.subtitle')}</p>
      <button type="button" className="mt-3 text-sm font-semibold text-accent hover:underline" onClick={() => setStep('select')}>
        {t('mentors.join.changeType', { type: t(mentorType === 'INDIVIDUAL' ? 'mentors.join.individual' : 'mentors.join.course') })}
      </button>

      {showSummary && <ErrorSummary errors={errors} />}

      {/* method="post": a native submit before hydration must never become a
          GET that puts the password in the address bar. See RegisterForm. */}
      <form method="post" onSubmit={submit} noValidate className="mt-7">
        <ProfileFields
          value={form}
          errors={errors}
          onChange={update}
          showEmail={mentorType === 'INDIVIDUAL'}
          showPhone
          showPassword
          universityOptional
          showUniversity={mentorType !== 'COURSE'}
          fullNameLabel={mentorType === 'COURSE' ? t('mentors.join.courseName') : undefined}
          universityHint={t('mentors.join.universityHint')}
        />

        {mentorType === 'COURSE' && <label className="mt-6 block text-sm font-medium">{t('mentors.join.courseEmail')}
          <input type="email" required value={courseEmail} onChange={(event) => {
            setCourseEmail(event.target.value);
            update({ email: event.target.value });
          }} className="input mt-1 w-full" autoComplete="email" />
        </label>}

        {mentorType === 'COURSE' && <label className="mt-5 block text-sm font-medium">{t('mentors.join.teacherCount')}
          <input type="number" required min={2} max={30} step={1} value={teacherCount} onChange={(event) => setTeacherCount(event.target.value)} className="input mt-1 w-full" inputMode="numeric" />
        </label>}

        {mentorType && <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft p-4 text-sm leading-relaxed text-fg">
          <p className="font-semibold">{t('mentors.join.monthlyFee', { amount: mentorType === 'COURSE' ? '30' : '10' })}</p>
          <p className="mt-2">{t('mentors.join.paymentNotice')}</p>
        </div>}

        <p className="mt-5 flex items-start gap-2.5 rounded-xl border border-edge bg-surface-muted p-3.5 text-xs leading-relaxed text-fg-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
          <span className="min-w-0">{t('mentors.join.nextSteps')}</span>
        </p>

        {formError && (
          <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
            {t(formError)}
          </p>
        )}

        <button type="submit" disabled={submitting} className="btn-primary mt-6 h-11 w-full disabled:cursor-wait">
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <GraduationCap className="h-4 w-4" aria-hidden="true" />
          )}
          {t('mentors.join.submit')}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-fg-muted">
        {t('mentors.join.haveAccount')}{' '}
        <Link href="/login?next=/mentors/apply" className="font-semibold text-accent hover:underline">
          {t('mentors.join.signInToApply')}
        </Link>
      </p>

      <p className="mt-2 text-center text-xs text-fg-subtle">
        {t('mentors.join.student')}{' '}
        <Link href="/register" className="font-semibold text-accent hover:underline">
          {t('nav.register')}
        </Link>
      </p>
    </div>
  );
}
