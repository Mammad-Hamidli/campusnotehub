'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, AtSign, Eye, EyeOff } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import type { AccountForm, FieldErrors } from './types';

// Re-exported so existing imports keep working; the list itself now lives in
// src/lib/universities.ts alongside the domain map that powers auto-detection.
export { UNIVERSITIES } from '@/lib/universities';

export function StepAccount({
  value,
  errors,
  onChange,
  onEmailChange,
}: {
  value: AccountForm;
  errors: FieldErrors;
  onChange: (patch: Partial<AccountForm>) => void;
  /** Fires alongside onChange so the parent can run domain auto-detection. */
  onEmailChange?: (email: string) => void;
}) {
  const t = useT();
  const [showPassword, setShowPassword] = useState(false);

  const strength = passwordStrength(value.password);

  return (
    <div className="space-y-5">
      {/*
        The legal name, in two halves.

        Collected separately because verification compares given name and
        surname against the identity document independently. The helper text
        under each is the document-consistency notice: these values WILL be
        checked, and a mismatch found after four photographs have been uploaded
        is a much worse experience than a sentence read before typing.
      */}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="firstName"
          label={t('auth.register.firstName')}
          hint={t('auth.register.documentNotice')}
          error={errors.firstName && t(errors.firstName)}
        >
          <input
            id="firstName"
            name="given-name"
            autoComplete="given-name"
            required
            aria-required="true"
            value={value.firstName}
            onChange={(e) => onChange({ firstName: e.target.value })}
            placeholder="Aysel"
            className={inputClass(!!errors.firstName)}
          />
        </Field>

        <Field
          id="lastName"
          label={t('auth.register.lastName')}
          hint={t('auth.register.documentNotice')}
          error={errors.lastName && t(errors.lastName)}
        >
          <input
            id="lastName"
            name="family-name"
            autoComplete="family-name"
            required
            aria-required="true"
            value={value.lastName}
            onChange={(e) => onChange({ lastName: e.target.value })}
            placeholder="Məmmədova"
            className={inputClass(!!errors.lastName)}
          />
        </Field>
      </div>

      <Field
        id="dateOfBirth"
        label={t('auth.register.dateOfBirth')}
        hint={t('auth.register.documentNotice')}
        error={errors.dateOfBirth && t(errors.dateOfBirth)}
      >
        <input
          id="dateOfBirth"
          type="date"
          name="bday"
          autoComplete="bday"
          required
          aria-required="true"
          value={value.dateOfBirth}
          onChange={(e) => onChange({ dateOfBirth: e.target.value })}
          // Bounds mirror the server's plausibility window, so the native
          // picker cannot offer a value the API will reject.
          min="1925-01-01"
          max={new Date(Date.now() - 16 * 365.2425 * 86_400_000).toISOString().slice(0, 10)}
          className={inputClass(!!errors.dateOfBirth)}
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
