'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, AtSign, Eye, EyeOff } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import type { AccountForm, FieldErrors } from './types';
import { FacultySelect } from './FacultySelect';
import { UNIVERSITIES as UNI_LIST } from '@/lib/universities';

// Re-exported so existing imports keep working; the list itself now lives in
// src/lib/universities.ts alongside the domain map that powers auto-detection.
export { UNIVERSITIES } from '@/lib/universities';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

export function StepAccount({
  value,
  errors,
  onChange,
  onEmailChange,
  onUniversityManualChange,
  autoDetected = false,
}: {
  value: AccountForm;
  errors: FieldErrors;
  onChange: (patch: Partial<AccountForm>) => void;
  /** Fires alongside onChange so the parent can run domain auto-detection. */
  onEmailChange?: (email: string) => void;
  /** Latches the manual override so auto-detect stops overwriting. */
  onUniversityManualChange?: () => void;
  /** True when the current selection came from the email domain. */
  autoDetected?: boolean;
}) {
  const t = useT();
  const [showPassword, setShowPassword] = useState(false);

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return Array.from({ length: 12 }, (_, i) => now - 3 + i);
  }, []);

  const strength = passwordStrength(value.password);

  return (
    <div className="space-y-5">
      <Field
        id="fullName"
        label={t('auth.register.fullName')}
        hint={t('auth.register.fullNameHint')}
        error={errors.fullName && t(errors.fullName)}
      >
        <input
          id="fullName"
          name="name"
          autoComplete="name"
          required
          aria-required="true"
          value={value.fullName}
          onChange={(e) => onChange({ fullName: e.target.value })}
          placeholder="Aysel Məmmədova"
          className={inputClass(!!errors.fullName)}
        />
      </Field>

      {/* Nickname sits directly under the legal name so the relationship
          between them is obvious at the moment of entry: one is checked against
          the ID, the other is what everyone actually sees. */}
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
            placeholder="nickname"
            className={`${inputClass(!!errors.nickname)} pl-8`}
          />
        </div>
      </Field>

      <Field
        id="email"
        label={t('auth.register.email')}
        hint={t('auth.register.emailHint')}
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
            // Auto-detect runs on every keystroke; the hook itself decides
            // whether the domain is complete enough to act on.
            onEmailChange?.(e.target.value);
          }}
          placeholder="aysel@ada.edu.az"
          className={inputClass(!!errors.email)}
        />
      </Field>

      <Field
        id="phone"
        label={t('auth.register.phone')}
        hint={t('auth.register.phoneHint')}
        error={errors.phone && t(errors.phone)}
      >
        <input
          id="phone"
          name="tel"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          aria-required="true"
          value={value.phone}
          onChange={(e) => onChange({ phone: e.target.value })}
          placeholder="+994 50 123 45 67"
          className={inputClass(!!errors.phone)}
        />
      </Field>

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
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            aria-required="true"
            value={value.password}
            onChange={(e) => onChange({ password: e.target.value })}
            className={`${inputClass(!!errors.password)} pr-10`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? t('auth.register.hidePassword') : t('auth.register.showPassword')}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-fg-subtle
 transition-colors hover:text-fg"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="university"
          label={t('auth.register.university')}
          error={errors.universityId && t(errors.universityId)}
          hint={autoDetected ? t('auth.register.universityAutoDetected') : undefined}
        >
          <select
            id="university"
            required
            aria-required="true"
            value={value.universityId}
            onChange={(e) => {
              onChange({ universityId: e.target.value });
              onUniversityManualChange?.();
            }}
            className={selectClass(!!errors.universityId)}
          >
            <option value="">{t('auth.register.universityPlaceholder')}</option>
            {UNI_LIST.map((uni) => (
              <option key={uni.id} value={uni.id}>
                {uni.id} — {uni.az}
              </option>
            ))}
          </select>
        </Field>

        {/* Faculty sits beside university because the two are read together:
            "ADA / Computer Science" is one fact about the student, and
            splitting them across the form makes the second look optional. */}
        <div className="sm:col-span-2">
          <FacultySelect
            value={value.facultySlug}
            otherValue={value.facultyOther}
            onChange={(facultySlug) => onChange({ facultySlug })}
            onOtherChange={(facultyOther) => onChange({ facultyOther })}
            error={errors.facultySlug && t(errors.facultySlug)}
            otherError={errors.facultyOther && t(errors.facultyOther)}
          />
        </div>

        <Field
          id="gradYear"
          label={t('auth.register.graduationDate')}
          error={
            (errors.graduationYear && t(errors.graduationYear)) ||
            (errors.graduationMonth && t(errors.graduationMonth))
          }
        >
          <div className="grid grid-cols-2 gap-2">
            <select
              id="gradYear"
              required
              aria-required="true"
              aria-label={t('auth.register.graduationYear')}
              value={value.graduationYear}
              onChange={(e) => onChange({ graduationYear: e.target.value })}
              className={selectClass(!!errors.graduationYear)}
            >
              <option value="">{t('auth.register.graduationYear')}</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            {/* Required, not optional: the 1 May sweep needs the month to know
                whether someone graduating "in 2026" has graduated yet. */}
            <select
              required
              aria-required="true"
              aria-label={t('auth.register.graduationMonth')}
              value={value.graduationMonth}
              onChange={(e) => onChange({ graduationMonth: e.target.value })}
              className={selectClass(!!errors.graduationMonth)}
            >
              <option value="">{t('auth.register.graduationMonth')}</option>
              {MONTHS.map((month) => (
                <option key={month} value={String(Number(month))}>
                  {month}
                </option>
              ))}
            </select>
          </div>
        </Field>
      </div>

      {/*
        Two SEPARATE consents.
        Bundling document processing into the general ToS checkbox is not valid
        consent for special-category data under GDPR Art. 9 or the AZ personal
        data law, and a bundled consent is worth nothing in a dispute.

        Each now renders its OWN error message. Previously they only tinted a
        16px border, so failing validation here looked exactly like a dead
        button — which is precisely the reported bug.
      */}
      <fieldset className="space-y-3 rounded-xl border border-edge bg-surface-muted p-4">
        <legend className="sr-only">{t('auth.register.consentsLegend')}</legend>

        <Checkbox
          id="terms"
          checked={value.acceptTerms}
          onChange={(checked) => onChange({ acceptTerms: checked })}
          error={errors.acceptTerms && t(errors.acceptTerms)}
        >
          {t('auth.register.termsAccept').replace(/<\/?terms>|<\/?privacy>/g, '')}
        </Checkbox>

        <Checkbox
          id="consent"
          checked={value.consentDocuments}
          onChange={(checked) => onChange({ consentDocuments: checked })}
          error={errors.consentDocuments && t(errors.consentDocuments)}
        >
          {t('auth.register.dataConsent')}
        </Checkbox>
      </fieldset>
    </div>
  );
}

function inputClass(invalid: boolean) {
  return `input ${invalid ? 'input-invalid' : ''}`;
}

function selectClass(invalid: boolean) {
  return `${inputClass(invalid)} appearance-none bg-[length:1rem] bg-[right_0.6rem_center] bg-no-repeat pr-8
    [background-image:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20fill='none'%20stroke='%2394a3b8'%20stroke-width='2'%20viewBox='0%200%2024%2024'%3E%3Cpath%20d='m6%209%206%206%206-6'/%3E%3C/svg%3E")]`;
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
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 text-xs text-danger"
        >
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
          className={`mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-2 bg-surface
                      text-accent transition-colors focus:ring-accent
                      ${error ? 'border-danger' : 'border-edge-strong'}`}
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
 * minimum, at least 5 distinct, no composition requirements. Composition rules
 * reliably produce "Parol123!"; length produces actual entropy.
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
