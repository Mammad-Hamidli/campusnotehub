'use client';

import { useMemo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { UNIVERSITIES } from '@/lib/universities';
import { FacultySelect } from './FacultySelect';
import type { AccountForm, FieldErrors } from './types';
import { isProfessional } from './types';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/**
 * Step 3: the fields that depend on the account type.
 *
 * Both branches share the university selector, because a teacher and a student
 * both belong to an institution and the platform's whole model is
 * university-scoped. Everything below that differs:
 *
 *   STUDENT - student number, faculty, graduation date. These are the claims a
 *             student card can actually corroborate.
 *   TEACHER - department and academic position. There is no graduation date to
 *             ask for, and the graduation cron must never target a teacher.
 *   MENTOR  - the same two columns, asked in the mentor's own vocabulary
 *             (organisation and position) because a mentor is frequently an
 *             industry professional with no academic title. Reusing the
 *             existing fields rather than adding parallel ones keeps one
 *             meaning per column; the fuller mentor profile - headline, bio,
 *             expertise, rates - is collected later at /mentors/apply, where a
 *             moderator reviews it.
 *
 * The same split is enforced server-side by conditional refinements in
 * src/server/validators/auth.ts; this component decides what to SHOW, not what
 * is allowed.
 */
export function StepDetails({
  value,
  errors,
  onChange,
}: {
  value: AccountForm;
  errors: FieldErrors;
  onChange: (patch: Partial<AccountForm>) => void;
}) {
  const t = useT();

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return Array.from({ length: 12 }, (_, i) => now - 3 + i);
  }, []);

  const isStudent = !isProfessional(value.accountType);
  const isMentor = value.accountType === 'MENTOR';

  return (
    <div className="space-y-5">
      <Field
        id="university"
        label={t('auth.register.university')}
        error={errors.universityId && t(errors.universityId)}
      >
        <select
          id="university"
          required
          aria-required="true"
          value={value.universityId}
          onChange={(e) => onChange({ universityId: e.target.value })}
          className={inputClass(!!errors.universityId)}
        >
          <option value="">{t('auth.register.universityPlaceholder')}</option>
          {UNIVERSITIES.map((uni) => (
            <option key={uni.id} value={uni.id}>
              {uni.id} — {uni.az}
            </option>
          ))}
        </select>
      </Field>

      {isStudent ? (
        <>
          <Field
            id="studentNumber"
            label={t('auth.register.studentNumber')}
            /* The helper text the brief asks for: this value is cross-checked
               against the student card, so it has to match exactly. */
            hint={t('auth.register.documentNotice')}
            error={errors.studentNumber && t(errors.studentNumber)}
          >
            <input
              id="studentNumber"
              required
              aria-required="true"
              value={value.studentNumber}
              onChange={(e) => onChange({ studentNumber: e.target.value })}
              maxLength={40}
              placeholder={t('auth.register.studentNumberPlaceholder')}
              className={inputClass(!!errors.studentNumber)}
            />
          </Field>

          <FacultySelect
            value={value.facultySlug}
            otherValue={value.facultyOther}
            onChange={(facultySlug) => onChange({ facultySlug })}
            onOtherChange={(facultyOther) => onChange({ facultyOther })}
            error={errors.facultySlug && t(errors.facultySlug)}
            otherError={errors.facultyOther && t(errors.facultyOther)}
          />

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
                className={inputClass(!!errors.graduationYear)}
              >
                <option value="">{t('auth.register.graduationYear')}</option>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
              {/* Required, not optional: the 1 May sweep needs the month to
                  know whether someone graduating "in 2026" has graduated. */}
              <select
                required
                aria-required="true"
                aria-label={t('auth.register.graduationMonth')}
                value={value.graduationMonth}
                onChange={(e) => onChange({ graduationMonth: e.target.value })}
                className={inputClass(!!errors.graduationMonth)}
              >
                <option value="">{t('auth.register.graduationMonth')}</option>
                {MONTHS.map((month) => (
                  <option key={month} value={month}>
                    {month}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        </>
      ) : (
        <>
          <Field
            id="department"
            label={t(isMentor ? 'auth.register.organisation' : 'auth.register.department')}
            error={errors.department && t(errors.department)}
          >
            <input
              id="department"
              required
              aria-required="true"
              value={value.department}
              onChange={(e) => onChange({ department: e.target.value })}
              maxLength={120}
              placeholder={t(
                isMentor
                  ? 'auth.register.organisationPlaceholder'
                  : 'auth.register.departmentPlaceholder',
              )}
              className={inputClass(!!errors.department)}
            />
          </Field>

          <Field
            id="academicTitle"
            label={t(isMentor ? 'auth.register.position' : 'auth.register.academicTitle')}
            error={errors.academicTitle && t(errors.academicTitle)}
          >
            <input
              id="academicTitle"
              required
              aria-required="true"
              value={value.academicTitle}
              onChange={(e) => onChange({ academicTitle: e.target.value })}
              maxLength={120}
              placeholder={t(
                isMentor
                  ? 'auth.register.positionPlaceholder'
                  : 'auth.register.academicTitlePlaceholder',
              )}
              className={inputClass(!!errors.academicTitle)}
            />
          </Field>

          {/* Faculty is optional context here rather than a verified claim -
              there is no document that corroborates it - so it is offered but
              never required. */}
          <FacultySelect
            value={value.facultySlug}
            otherValue={value.facultyOther}
            onChange={(facultySlug) => onChange({ facultySlug })}
            onOtherChange={(facultyOther) => onChange({ facultyOther })}
            error={errors.facultySlug && t(errors.facultySlug)}
            otherError={errors.facultyOther && t(errors.facultyOther)}
          />
        </>
      )}
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
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-fg">
        {label}
        <span className="ml-1 text-danger" aria-hidden="true">
          *
        </span>
      </label>
      {children}
      {hint && !error && <p className="mt-1.5 text-xs text-fg-subtle">{hint}</p>}
      {error && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-danger" role="alert">
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
