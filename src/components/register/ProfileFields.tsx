'use client';

import { useState, type ReactNode } from 'react';
import { AlertCircle, AtSign, Eye, EyeOff, Phone } from 'lucide-react';
import { useT, useLocale } from '@/lib/i18n/LocaleProvider';
import { UNIVERSITIES } from '@/lib/universities';
import type { ProfileErrors, ProfileForm } from './types';

/**
 * The registration fields, shared by /register (all of them) and /onboarding
 * (no password, no phone; email only when the provider supplied none).
 *
 * One component so the two forms can never ask for a name or a nickname in
 * two different ways. Controlled: the parent owns the values and the errors.
 */
export function ProfileFields({
  value,
  errors,
  onChange,
  showEmail,
  showPhone = false,
  showPassword,
  emailHint,
  onEmailChange,
  onUniversityPicked,
  universityHint,
}: {
  value: ProfileForm;
  errors: ProfileErrors;
  onChange: (patch: Partial<ProfileForm>) => void;
  showEmail: boolean;
  /** Registration only. /onboarding leaves it off and defaults to false. */
  showPhone?: boolean;
  showPassword: boolean;
  emailHint?: string;
  /** Fires alongside onChange so the parent can run domain auto-detection. */
  onEmailChange?: (email: string) => void;
  /** A manual university pick - latches auto-detection off. */
  onUniversityPicked?: () => void;
  universityHint?: string;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [reveal, setReveal] = useState(false);
  const strength = passwordStrength(value.password);

  return (
    <div className="space-y-5">
      <Field id="fullName" label={t('auth.register.fullName')} hint={t('auth.register.nameHint')} error={errors.fullName && t(errors.fullName)}>
        <input
          id="fullName"
          name="name"
          autoComplete="name"
          required
          aria-required="true"
          maxLength={120}
          value={value.fullName}
          onChange={(e) => onChange({ fullName: e.target.value })}
          placeholder={t('auth.register.fullNamePlaceholder')}
          className={inputClass(!!errors.fullName)}
        />
      </Field>

      <Field
        id="nickname"
        label={t('auth.register.nickname')}
        hint={t('auth.register.nicknameHint')}
        error={errors.nickname && t(errors.nickname)}
      >
        <div className="relative">
          <AtSign
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <input
            id="nickname"
            name="username"
            autoComplete="username"
            required
            aria-required="true"
            spellCheck={false}
            maxLength={24}
            value={value.nickname}
            onChange={(e) => onChange({ nickname: e.target.value.replace(/\s/g, '') })}
            placeholder={t('auth.register.nicknamePlaceholder')}
            className={`${inputClass(!!errors.nickname)} pl-8`}
          />
        </div>
      </Field>

      <Field
        id="university"
        label={t('auth.register.university')}
        hint={universityHint}
        error={errors.universityId && t(errors.universityId)}
      >
        <select
          id="university"
          required
          aria-required="true"
          value={value.universityId}
          onChange={(e) => {
            onChange({ universityId: e.target.value });
            onUniversityPicked?.();
          }}
          className={inputClass(!!errors.universityId)}
        >
          <option value="">{t('auth.register.universityPlaceholder')}</option>
          {UNIVERSITIES.map((uni) => (
            <option key={uni.id} value={uni.id}>
              {uni.id} — {locale === 'en' ? uni.en : locale === 'ru' ? uni.ru : uni.az}
            </option>
          ))}
        </select>
      </Field>

      {showEmail && (
        <Field
          id="email"
          label={t('auth.register.personalEmail')}
          hint={emailHint ?? t('auth.register.personalEmailHint')}
          error={errors.email && t(errors.email)}
        >
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            aria-required="true"
            value={value.email}
            onChange={(e) => {
              onChange({ email: e.target.value });
              onEmailChange?.(e.target.value);
            }}
            placeholder={t('auth.register.emailPlaceholder')}
            className={inputClass(!!errors.email)}
          />
        </Field>
      )}

      {showPhone && (
        <Field
          id="phone"
          label={t('auth.register.phone')}
          hint={t('auth.register.phoneHint')}
          error={errors.phone && t(errors.phone)}
        >
          <div className="relative">
            <Phone
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            {/*
              type="tel" rather than type="number": a number input strips the
              leading '+', rejects the spaces people type a phone number with,
              and puts a spinner on a field nobody wants to increment. `tel`
              brings up the phone keypad on a handset, which is the whole
              benefit. inputMode is stated too because Firefox ignores the
              keypad hint of type="tel" on its own.
            */}
            <input
              id="phone"
              name="tel"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              aria-required="true"
              maxLength={20}
              value={value.phone}
              // Only the characters a phone number can contain. Typing a
              // letter does nothing rather than producing an error on blur.
              onChange={(e) => onChange({ phone: e.target.value.replace(/[^\d+\s()-]/g, '') })}
              placeholder={t('auth.register.phonePlaceholder')}
              className={`${inputClass(!!errors.phone)} pl-8`}
            />
          </div>
        </Field>
      )}

      {showPassword && (
        <Field
          id="password"
          label={t('auth.register.password')}
          hint={t('auth.register.passwordHint')}
          error={errors.password && t(errors.password)}
        >
          <div className="relative">
            <input
              id="password"
              name="new-password"
              type={reveal ? 'text' : 'password'}
              autoComplete="new-password"
              required
              aria-required="true"
              value={value.password}
              onChange={(e) => onChange({ password: e.target.value })}
              className={`${inputClass(!!errors.password)} pr-10`}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? t('auth.register.hidePassword') : t('auth.register.showPassword')}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-fg-subtle transition-colors hover:text-fg"
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {value.password.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex h-0.5 flex-1 gap-1" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={`h-full flex-1 rounded-full transition-colors duration-200 ${
                      i < strength.score ? strength.bar : 'bg-edge'
                    }`}
                  />
                ))}
              </div>
              <span className={`text-2xs font-medium ${strength.tone}`}>{t(strength.labelKey)}</span>
            </div>
          )}
        </Field>
      )}

      <fieldset className="rounded-xl border border-edge bg-surface-muted p-4">
        <legend className="sr-only">{t('auth.register.consentsLegend')}</legend>
        <Checkbox
          id="terms"
          checked={value.acceptTerms}
          onChange={(checked) => onChange({ acceptTerms: checked })}
          error={errors.acceptTerms && t(errors.acceptTerms)}
        >
          <ConsentText template={t('auth.register.termsAccept')} />
        </Checkbox>
      </fieldset>
    </div>
  );
}

/**
 * "I agree to the <terms>Terms</terms> and <privacy>Privacy Policy</privacy>"
 * with the tagged spans rendered as links (new tab, so typed values survive).
 */
const CONSENT_LINKS: Record<string, string> = { terms: '/legal/terms', privacy: '/legal/privacy' };

function ConsentText({ template }: { template: string }) {
  const t = useT();
  const parts = template.split(/<(terms|privacy)>(.*?)<\/\1>/);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) nodes.push(parts[i]);
    const tag = parts[i + 1];
    if (!tag) continue;
    nodes.push(
      <a
        key={tag}
        href={CONSENT_LINKS[tag]}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-accent underline underline-offset-2 hover:no-underline"
      >
        {parts[i + 2]}
        <span className="sr-only"> {t('legal.opensInNewTab')}</span>
      </a>,
    );
  }
  return <>{nodes}</>;
}

function inputClass(invalid: boolean) {
  return `input ${invalid ? 'input-invalid' : ''}`;
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | false;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1 text-sm font-medium text-fg">
        {label}
        <span className="text-danger" aria-hidden="true">
          *
        </span>
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs leading-snug text-fg-muted">{hint}</p>
      ) : null}
    </div>
  );
}

function Checkbox({
  id,
  checked,
  onChange,
  error,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string | false;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          required
          aria-required="true"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className={`mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-2 bg-surface text-accent transition-colors focus:ring-accent ${
            error ? 'border-danger' : 'border-edge-strong'
          }`}
        />
        <span className="min-w-0 text-xs leading-relaxed text-fg-muted">{children}</span>
      </label>
      {error && (
        <p id={`${id}-error`} role="alert" className="ml-6.5 mt-1 flex items-start gap-1.5 text-xs text-danger">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Length-first strength meter, matching the server rule: 12 characters
 * minimum, at least 5 distinct, no composition requirements.
 */
function passwordStrength(password: string) {
  const distinct = new Set(password).size;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16 && distinct >= 8) score++;
  if (distinct >= 5 && password.length >= 12) score++;

  const levels = [
    { labelKey: 'auth.register.strength.weak', bar: 'bg-danger', tone: 'text-danger' },
    { labelKey: 'auth.register.strength.weak', bar: 'bg-danger', tone: 'text-danger' },
    { labelKey: 'auth.register.strength.fair', bar: 'bg-warn', tone: 'text-warn' },
    { labelKey: 'auth.register.strength.good', bar: 'bg-accent', tone: 'text-accent' },
    { labelKey: 'auth.register.strength.strong', bar: 'bg-verified', tone: 'text-verified' },
  ];

  return { score, ...levels[score] };
}
