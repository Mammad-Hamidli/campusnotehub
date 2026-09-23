'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowUpRight, GraduationCap, Loader2, ShieldAlert, ShieldCheck, UserPlus } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { MENTORS_URL } from '@/lib/site';
import { ProfileFields } from './ProfileFields';
import { ErrorSummary } from './ErrorSummary';
import { useUniversityAutoDetect } from './useUniversityAutoDetect';
import { EMPTY_PROFILE, collectFingerprint, validateProfile, type ProfileErrors, type ProfileForm } from './types';
import { normalizeAzPhone } from '@/lib/auth/phone';
import { GoogleMark } from '@/components/auth/GoogleMark';

const PROVIDER_LABELS: Record<string, string> = { google: 'Google' };

/**
 * Reads the server's per-field errors into the form's error state.
 *
 * Both the 400 (validation) and 409 (uniqueness) responses use
 * `{ fields: { <formKey>: [<localeKey>, ...] } }`. Keys the form does not
 * render are dropped rather than silently swallowing the whole response -
 * the caller falls back to a form-level message when nothing survives.
 */
function fieldErrorsFrom(body: unknown): ProfileErrors {
  const fields = (body as { fields?: unknown } | null)?.fields;
  if (!fields || typeof fields !== 'object') return {};

  const errors: ProfileErrors = {};
  for (const [key, messages] of Object.entries(fields as Record<string, unknown>)) {
    const first = Array.isArray(messages) ? messages[0] : messages;
    if (key in EMPTY_PROFILE && typeof first === 'string' && first) {
      errors[key as keyof ProfileForm] = first;
    }
  }
  return errors;
}

/**
 * Student registration: ONE step.
 *
 *   name, nickname, university, personal email, phone, password (+ terms)
 *
 * The previous four-step wizard (account -> type -> details -> schedule) is
 * gone. Identity is still proven later at /verify, and the capability table
 * in src/lib/permissions.ts is unchanged, so nothing that moves money opens
 * before verification. Mentors do not register here at all: the button at the
 * bottom sends them to their own site (MENTORS_URL).
 *
 * Quick login (Google) sits above the form. Those
 * accounts are created by the OAuth callback with a temporary handle and
 * finish their profile at /onboarding - see src/lib/auth/quick-signup.ts.
 */
export function RegisterForm({ providers }: { providers: string[] }) {
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
  // Guards a double press creating (or 409-ing on) a second account.
  const submittedRef = useRef(false);

  /** A university address still auto-selects the university; a personal one simply does not. */
  const autoDetect = useUniversityAutoDetect({
    onDetect: (universityId) => {
      setForm((prev) => ({ ...prev, universityId }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next.universityId;
        return next;
      });
    },
  });

  // Collected on mount, never in the critical path of the button press.
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

    const found = validateProfile(form, { requirePassword: true, requireEmail: true, requirePhone: true });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setShowSummary(true);
      return;
    }

    setShowSummary(false);
    setSubmitting(true);
    setFormError(null);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName.trim().replace(/\s+/g, ' '),
          nickname: form.nickname.trim(),
          universityId: form.universityId,
          email: form.email.trim().toLowerCase(),
          /*
            Sent in E.164. validateProfile() above has already refused anything
            normalizeAzPhone() cannot parse, so the `?? ''` is unreachable - it
            is there so this expression is a string rather than `string | null`,
            because a null would serialise into the body and be rejected by the
            schema as a type error instead of as the empty field it really is.
          */
          phone: normalizeAzPhone(form.phone) ?? '',
          password: form.password,
          locale: document.documentElement.lang || 'az',
          acceptTerms: form.acceptTerms,
          deviceFingerprint: fingerprint,
        }),
      });

      if (res.status === 403) {
        setBlocked(true);
        return;
      }

      const body = await res.json().catch(() => ({}));

      /**
       * 409 (a uniqueness clash) and 400 (a validation failure) now carry the
       * SAME `fields` shape, so one branch handles both.
       *
       * The old 409 branch had to guess: the server sent a single top-level
       * message, so anything that was not a nickname clash was painted onto
       * the email AND the phone at once. A number that was already in use read
       * as "your email is unusable too", which is the report this fixes. The
       * server now names each offending field and the form shows exactly
       * those.
       */
      if (res.status === 409 || res.status === 400) {
        const fieldErrors = fieldErrorsFrom(body);
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          setShowSummary(true);
          return;
        }
        // A 409 with nothing the form can point at (a provider identity
        // clash) still has to say something.
        if (res.status === 409) {
          setFormError(typeof body.error === 'string' ? body.error : 'auth.errors.credentialsUnavailable');
          return;
        }
      }

      if (!res.ok) {
        setFormError(res.status === 429 ? 'errors.rateLimited' : res.status === 400 ? 'errors.validationFailed' : 'errors.generic');
        return;
      }

      submittedRef.current = true;
      toast.success(t('register.created'));
      router.push('/dashboard');
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

  return (
    <div className="mx-auto w-full max-w-lg animate-rise">
      <h1 className="text-balance text-2xl font-bold tracking-tight text-fg">{t('auth.register.title')}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t('auth.register.subtitle')}</p>

      {providers.length > 0 && (
        <>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {providers.map((provider) => (
              // Plain navigation: the flow leaves this site for the provider.
              <a
                key={provider}
                href={`/api/auth/oauth/${provider}/start`}
                className="btn-secondary w-full justify-center gap-2.5 py-2.5"
              >
                {provider === 'google' && <GoogleMark />}
                {t('auth.oauth.continueWith', { provider: PROVIDER_LABELS[provider] ?? provider })}
              </a>
            ))}
          </div>
          <p className="mt-2 text-2xs leading-snug text-fg-subtle">{t('auth.register.quickHint')}</p>

          <div className="my-6 flex items-center gap-3 text-2xs uppercase tracking-wide text-fg-subtle">
            <span className="h-px flex-1 bg-edge" aria-hidden="true" />
            {t('auth.oauth.or')}
            <span className="h-px flex-1 bg-edge" aria-hidden="true" />
          </div>
        </>
      )}

      {showSummary && <ErrorSummary errors={errors} />}

      {/*
        method="post" is a SECURITY control: before hydration (or if the bundle
        fails) a native submit becomes a POST to this page - a 405 - instead of
        a GET that would serialise the password into the address bar.
      */}
      <form method="post" onSubmit={submit} noValidate className={providers.length > 0 ? '' : 'mt-7'}>
        <ProfileFields
          value={form}
          errors={errors}
          onChange={update}
          showEmail
          showPhone
          showPassword
          onEmailChange={autoDetect.handleEmailChange}
          onUniversityPicked={autoDetect.handleManualChange}
          universityHint={autoDetect.wasAutoDetected ? t('auth.register.universityAutoDetected') : undefined}
        />

        <p className="mt-5 flex items-start gap-2.5 rounded-xl border border-edge bg-surface-muted p-3.5 text-xs leading-relaxed text-fg-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
          <span className="min-w-0">{t('auth.register.verifyLater')}</span>
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
            <UserPlus className="h-4 w-4" aria-hidden="true" />
          )}
          {t('auth.register.createAccount')}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-fg-muted">
        {t('auth.register.haveAccount')}{' '}
        <Link href="/login" className="font-semibold text-accent hover:underline">
          {t('nav.login')}
        </Link>
      </p>

      {/* Mentors apply on their own site. A plain external link: the
          subdomain is a separate app with its own flow. */}
      <div className="mt-8 rounded-2xl border border-dashed border-edge-strong p-4 text-center">
        <p className="text-xs text-fg-muted">{t('auth.register.mentorHint')}</p>
        <a
          href={MENTORS_URL}
          className="btn-secondary mt-3 w-full py-2.5 font-semibold"
          rel="noopener"
        >
          <GraduationCap className="h-4 w-4" aria-hidden="true" />
          {t('auth.register.mentorCta')}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
