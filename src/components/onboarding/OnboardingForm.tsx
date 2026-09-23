'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Loader2, Sparkles } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { ProfileFields } from '@/components/register/ProfileFields';
import { ErrorSummary } from '@/components/register/ErrorSummary';
import { EMPTY_PROFILE, validateProfile, type ProfileErrors, type ProfileForm } from '@/components/register/types';

/**
 * Finishing a quick-login account: name, nickname, university (and an email
 * only when the provider supplied none). Posts to /api/me/onboarding, which
 * swaps the temporary handle for the chosen one and lifts the view-only gate.
 */
export function OnboardingForm({
  temporaryHandle,
  initialName,
  needsEmail,
}: {
  temporaryHandle: string;
  initialName: string;
  needsEmail: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();

  const [form, setForm] = useState<ProfileForm>({ ...EMPTY_PROFILE, fullName: initialName });
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [showSummary, setShowSummary] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    if (submitting) return;

    const found = validateProfile(form, { requirePassword: false, requireEmail: needsEmail });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setShowSummary(true);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch('/api/me/onboarding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName.trim().replace(/\s+/g, ' '),
          nickname: form.nickname.trim(),
          universityId: form.universityId,
          ...(needsEmail ? { email: form.email.trim().toLowerCase() } : {}),
          acceptTerms: form.acceptTerms,
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 409 && body.field) {
        setErrors({ [body.field as keyof ProfileForm]: body.error });
        setShowSummary(true);
        return;
      }
      if (res.status === 409) {
        // Already complete (another tab finished first) - nothing left to do here.
        router.replace('/dashboard');
        return;
      }
      if (!res.ok) {
        setFormError(res.status === 429 ? 'errors.rateLimited' : res.status === 400 ? 'errors.validationFailed' : 'errors.generic');
        return;
      }

      toast.success(t('onboarding.done'));
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setFormError('errors.generic');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg animate-rise">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand">
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        {t('onboarding.badge')}
      </span>
      <h1 className="mt-3 text-balance text-2xl font-bold tracking-tight text-fg">{t('onboarding.title')}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t('onboarding.subtitle')}</p>

      <p className="mt-4 flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn-soft p-3.5 text-xs leading-relaxed text-warn-fg">
        <Eye className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{t('onboarding.viewOnly', { handle: temporaryHandle })}</span>
      </p>

      <div className="mt-6">{showSummary && <ErrorSummary errors={errors} />}</div>

      <form method="post" onSubmit={submit} noValidate>
        <ProfileFields
          value={form}
          errors={errors}
          onChange={update}
          showEmail={needsEmail}
          showPassword={false}
        />

        {formError && (
          <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
            {t(formError)}
          </p>
        )}

        <button type="submit" disabled={submitting} className="btn-primary mt-6 h-11 w-full disabled:cursor-wait">
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('onboarding.submit')}
        </button>
      </form>
    </div>
  );
}
