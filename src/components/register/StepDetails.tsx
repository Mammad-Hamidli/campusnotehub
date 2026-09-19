'use client';

import { useMemo, type ReactNode } from 'react';
import { AlertCircle, GraduationCap, School } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { UNIVERSITIES } from '@/lib/universities';
import { FacultySelect } from './FacultySelect';
import type { AcademicStatus, AccountForm, FieldErrors } from './types';
import { isProfessional } from './types';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/**
 * Step 3: the fields that depend on the account type.
 *
 * Both branches share the university selector, because a mentor and a student
 * both belong to an institution and the platform's whole model is
 * university-scoped. Everything below that differs:
 *
 *   STUDENT - academic status, student number, faculty, graduation date.
 *   MENTOR  - organisation and position, because a mentor is frequently an
 *             industry professional with no academic title. The fuller mentor
 *             profile - headline, bio, expertise, rates - is collected later
 *             at /mentors/apply, where a moderator reviews it.
 *
 * ---------------------------------------------------------------------------
 * ACADEMIC STATUS SITS WITH THE UNIVERSITY, NOT AFTER IT
 * ---------------------------------------------------------------------------
 * "Which university" and "are you still there" are one question asked twice,
 * and separating them produced the failure this step exists to fix: a
 * graduate picking their old university, being handed a form that assumes
 * enrolment, and ending up with a student account that could never be
 * verified because they have no valid student card.
 *
 * Answering it here also makes the graduation date legible. The same two
 * dropdowns mean "when you finished" or "when you expect to finish" depending
 * on this choice, and the labels below say which.
 *
 * The same split is enforced server-side by conditional refinements in
 * src/server/validators/auth.ts; this component decides what to SHOW, not
 * what is allowed.
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

  const graduated = value.academicStatus === 'GRADUATED';

  /**
   * The year range follows the status.
   *
   * A graduate needs years behind them and a current student needs years
   * ahead; offering both to both is how "graduated in 2029" gets submitted.
   * The bounds stay inside the server's window (CURRENT_YEAR -15 .. +10).
   */
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    if (graduated) return Array.from({ length: 16 }, (_, i) => now - i);
    return Array.from({ length: 11 }, (_, i) => now + i);
  }, [graduated]);

  const isStudent = !isProfessional(value.accountType);
  const isMentor = value.accountType === 'MENTOR';

  return (
    <div className="space-y-5">
      {/* Required of a student; optional for a mentor, who is often an
          industry professional with no university. The empty option then
          means "not affiliated" rather than "not chosen yet". */}
      <Field
        id="university"
        label={t('auth.register.university')}
        optional={isMentor}
        hint={isMentor ? t('auth.register.universityMentorHint') : undefined}
        error={errors.universityId && t(errors.universityId)}
      >
        <select
          id="university"
          required={!isMentor}
          aria-required={!isMentor}
          value={value.universityId}
          onChange={(e) => onChange({ universityId: e.target.value })}
          className={inputClass(!!errors.universityId)}
        >
          <option value="">
            {t(isMentor ? 'auth.register.universityNone' : 'auth.register.universityPlaceholder')}
          </option>
          {UNIVERSITIES.map((uni) => (
            <option key={uni.id} value={uni.id}>
              {uni.id} — {uni.az}
            </option>
          ))}
        </select>
      </Field>

      {isStudent ? (
        <>
          <AcademicStatusChoice
            value={value.academicStatus}
            error={errors.academicStatus && t(errors.academicStatus)}
            onChange={(academicStatus) => onChange({ academicStatus })}
          />

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
            // The same two dropdowns, named for what they mean under the
            // status chosen above.
            label={t(
              graduated ? 'auth.register.graduatedDate' : 'auth.register.expectedGraduationDate',
            )}
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

/**
 * "Currently studying" / "Graduated".
 *
 * Two radio cards rather than a <select>, for the same reason the account
 * type uses them: the answer changes what the rest of the form means, and a
 * dropdown gives no room to say so. Stacked on a phone, side by side from
 * `sm` up.
 */
function AcademicStatusChoice({
  value,
  error,
  onChange,
}: {
  value: AcademicStatus | '';
  error?: string | false;
  onChange: (status: AcademicStatus) => void;
}) {
  const t = useT();

  const options: { status: AcademicStatus; icon: typeof School; titleKey: string; bodyKey: string }[] = [
    {
      status: 'STUDYING',
      icon: School,
      titleKey: 'auth.register.status.studying.title',
      bodyKey: 'auth.register.status.studying.body',
    },
    {
      status: 'GRADUATED',
      icon: GraduationCap,
      titleKey: 'auth.register.status.graduated.title',
      bodyKey: 'auth.register.status.graduated.body',
    },
  ];

  return (
    /*
      The invalid state belongs to the GROUP, not to either radio. aria-invalid
      is not a supported property of role="radio" - announcing it there would
      say "this option is invalid", which is not what is wrong. The group is
      what has no answer yet.
    */
    <fieldset aria-invalid={!!error} aria-describedby={error ? 'academic-status-error' : undefined}>
      <legend className="mb-1.5 flex items-center gap-1 text-sm font-medium text-fg">
        {t('auth.register.academicStatus')}
        <span className="text-danger" aria-hidden="true">
          *
        </span>
      </legend>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {options.map(({ status, icon: Icon, titleKey, bodyKey }) => {
          const selected = value === status;
          return (
            <label
              key={status}
              className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3.5 transition-colors ${
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-edge bg-surface hover:border-edge-strong hover:bg-surface-muted'
              }`}
            >
              <input
                type="radio"
                name="academicStatus"
                value={status}
                checked={selected}
                onChange={() => onChange(status)}
                className="sr-only"
                required
              />
              <Icon
                className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? 'text-accent' : 'text-fg-subtle'}`}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{t(titleKey)}</span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-fg-muted">
                  {t(bodyKey)}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {error && (
        <p
          id="academic-status-error"
          className="mt-1.5 flex items-center gap-1 text-xs text-danger"
          role="alert"
        >
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </fieldset>
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
  optional = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | false;
  /** Swaps the required asterisk for a visible "(optional)". */
  optional?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-fg">
        {label}
        {optional ? (
          <span className="ml-1.5 text-xs font-normal text-fg-subtle">({t('common.optional')})</span>
        ) : (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && <p className="mt-1.5 text-xs leading-snug text-fg-subtle">{hint}</p>}
      {error && (
        <p className="mt-1.5 flex items-start gap-1 text-xs text-danger" role="alert">
          <AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{error}</span>
        </p>
      )}
    </div>
  );
}
