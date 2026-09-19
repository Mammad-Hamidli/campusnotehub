'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { StepAccount } from './StepAccount';
import { StepAccountType } from './StepAccountType';
import { StepDetails } from './StepDetails';
import { StepSchedule } from './StepSchedule';
import { ErrorSummary } from './ErrorSummary';
import { useUniversityAutoDetect } from './useUniversityAutoDetect';
import { cellsToRules } from '@/lib/mentors/schedule';
import {
  EMPTY_ACCOUNT,
  collectFingerprint,
  validateAccount,
  type AccountForm,
  type AccountType,
  type FieldErrors,
} from './types';

/**
 * Three steps, not five.
 *
 * ---------------------------------------------------------------------------
 * REGISTRATION NO LONGER TOUCHES A DOCUMENT
 * ---------------------------------------------------------------------------
 * The wizard used to be account -> type -> details -> DOCUMENTS -> REVIEW, and
 * the last two steps were where the funnel died. Signing up meant finding a
 * national ID, photographing four sides of two cards in adequate light,
 * waiting 3-8 seconds for an inline analysis pipeline, and only then owning an
 * account. That is a demand made of a stranger who has not yet seen the
 * product, and the drop-off it produced is the reason this file changed.
 *
 * Identity still has to be proven - nothing about the verification rules
 * moved. What moved is WHEN. The account is created from typed fields alone,
 * the user lands in the product immediately as UNVERIFIED, and a persistent
 * prompt (src/components/account/IdentityPrompt.tsx) asks them to verify at
 * /verify whenever it suits them. The capability table in
 * src/lib/permissions.ts is untouched, so an unverified account still cannot
 * sell notes, book a mentor or withdraw money. The gate is in the same place;
 * only the queue in front of it is gone.
 *
 *   account  - name, date of birth, credentials (common to both types)
 *   type     - Student or Mentor
 *   details  - university, academic status, and the fields that follow
 *   schedule - MENTOR only: weekly availability (see StepSchedule)
 *
 * There is no review step either: with the documents gone there are eleven
 * fields left, all of them still on screen, and a summary of a form the user
 * is still looking at is a step that exists to be clicked through.
 */
type StepId = 'account' | 'type' | 'details' | 'schedule';

/** The step list follows the account type; only a mentor has a schedule. */
function stepsFor(accountType: AccountType | ''): StepId[] {
  return accountType === 'MENTOR'
    ? ['account', 'type', 'details', 'schedule']
    : ['account', 'type', 'details'];
}

export function RegisterWizard() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();

  const [step, setStep] = useState<StepId>('account');
  const [account, setAccount] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | undefined>();
  const [blocked, setBlocked] = useState<{ reference: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  // Guards against a double submission creating (or 409-ing on) a second
  // account if the button is pressed twice before the first response lands.
  const submittedRef = useRef(false);

  /**
   * Auto-selects the university from the email domain. The hook latches a
   * manual override, so once the user picks an institution by hand we never
   * overwrite it again - see useUniversityAutoDetect for why that matters.
   */
  const autoDetect = useUniversityAutoDetect({
    onDetect: (universityId) => {
      setAccount((prev) => ({ ...prev, universityId }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next.universityId;
        return next;
      });
    },
  });

  // Collected once on mount rather than at submit, so the ~5ms of canvas work
  // never sits in the critical path of the button press.
  useEffect(() => {
    void collectFingerprint().then(setFingerprint);
  }, []);

  // The device's zone is the best default for a mentor's schedule. Read after
  // mount, never during render, so server and client HTML agree.
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) setAccount((prev) => ({ ...prev, timezone: zone }));
  }, []);

  /**
   * Preselects the account type from `?type=`.
   *
   * This is what makes "Become a mentor" work for someone with no account:
   * /mentors/apply sends a signed-out visitor to /register?type=MENTOR, and
   * arriving with the question already answered is the whole point - being
   * asked "student or mentor?" immediately after clicking "Become a mentor"
   * reads as the product having ignored the click.
   *
   * Read from location rather than useSearchParams() deliberately: this page is
   * not otherwise dynamic, and useSearchParams() would force the whole wizard
   * into a Suspense boundary to satisfy the App Router's static-rendering rule.
   *
   * It only preselects - it never skips a step or submits anything, and an
   * unrecognised value is ignored, so the URL cannot put the form into a state
   * the user could not reach by clicking. TEACHER is deliberately NOT accepted
   * any more: it is not a type this form can produce, and honouring it would
   * leave the wizard holding a value none of its branches render.
   */
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('type')?.toUpperCase();
    if (requested === 'STUDENT' || requested === 'MENTOR') {
      setAccount((prev) => ({ ...prev, accountType: requested }));
    }
  }, []);

  const steps = stepsFor(account.accountType);
  const stepIndex = steps.indexOf(step);

  /**
   * THE NAVIGATION RULE.
   *
   * Every failure renders through <ErrorSummary/>, which takes focus, and the
   * transition is unconditional once validation passes. The earlier version
   * stored errors and returned - and two of those errors (the consent
   * checkboxes) had no visible representation, so pressing Continue appeared
   * to do nothing at all. The button read as broken; the state machine was
   * working fine.
   */

  /**
   * Step 1 -> Step 2. The ONLY place that decision is made.
   *
   * Deliberately pure state: it validates what is already in `account` and
   * flips `step`. It does not submit a form, does not navigate, and does not
   * touch the network - there is nothing here for a browser to take over. Both
   * entry points below funnel into it so the keyboard and the mouse can never
   * drift apart, which is how the two used to disagree.
   */
  function advanceFromAccount() {
    // Step 1 judges only the common fields - see ValidationScope.
    const found = validateAccount(account, 'basics');
    setErrors(found);

    const hasErrors = Object.keys(found).length > 0;
    setShowSummary(hasErrors);
    if (hasErrors) return;

    // Valid: advance. `account` is owned by this component and is NOT unmounted
    // by the transition - StepAccount is a controlled child, so every field the
    // user typed survives moving to step 2 and back.
    setShowSummary(false);
    setFormError(null);
    setStep('type');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Step 2 -> Step 3. The choice itself is the only thing to validate. */
  function advanceFromType() {
    if (!account.accountType) {
      setErrors({ accountType: 'errors.fieldRequired' });
      return;
    }
    setErrors({});
    setFormError(null);
    setStep('details');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Belt-and-braces only. With the Continue button now type="button" nothing
   * should ever submit this form, but if a future edit adds a type="submit"
   * control the handler is already here to stop the browser taking the wheel.
   */
  function handleAccountSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    advanceFromAccount();
  }

  /**
   * Restores Enter-to-continue.
   *
   * A form whose only button is type="button" gets no implicit submission from
   * the browser, so without this, Enter on the last field would do nothing -
   * the exact dead-feeling behaviour a previous fix set out to remove. Doing it
   * on keydown keeps the behaviour in JS, where preventDefault is guaranteed,
   * instead of borrowing the native submit path to get it.
   */
  function handleAccountKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;

    // Enter on a real control means what it normally means: newline in a
    // textarea, activate a button, follow a link, open a select.
    const el = event.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return;

    event.preventDefault();
    advanceFromAccount();
  }

  /**
   * Step 3 -> Step 4, mentors only. Everything but the schedule is judged
   * here, so a problem in the details is reported on the step that shows
   * those fields rather than one step later.
   */
  function advanceFromDetails() {
    const found = validateAccount(account, 'details');
    setErrors(found);
    const hasErrors = Object.keys(found).length > 0;
    setShowSummary(hasErrors);
    if (hasErrors) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setFormError(null);
    setStep('schedule');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearErrors(keys: (keyof AccountForm)[]) {
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of keys) delete next[key];
      if (Object.keys(next).length === 0) setShowSummary(false);
      return next;
    });
  }

  function goBack() {
    setStep(steps[Math.max(0, stepIndex - 1)]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Submit: ONE request.
   *
   * POST /api/auth/register  JSON -> 201, session cookies set, and that is the
   * whole of registration. The second call this function used to make - a
   * multipart POST to /api/verification/submit carrying four photographs - is
   * gone from this file entirely. It still exists, and is still the only way
   * to get verified; it now lives at /verify, which the user reaches when they
   * choose to.
   *
   * What that removes, beyond the friction: a failure mode where the account
   * was created and the upload then failed, leaving the wizard holding a
   * half-finished signup it had to detect and resume. There is nothing to
   * resume now - either the account exists or it does not.
   */
  async function submit() {
    if (submitting || submittedRef.current) return;

    const found = validateAccount(account);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setShowSummary(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
          accountType: account.accountType,
          firstName: account.firstName.trim(),
          lastName: account.lastName.trim(),
          dateOfBirth: account.dateOfBirth,
          nickname: account.nickname.trim(),
          email: account.email.trim().toLowerCase(),
          phone: account.phone.replace(/[\s-]/g, ''),
          password: account.password,
          passwordConfirm: account.password,
          universityId: account.universityId || undefined,
          facultySlug: account.facultySlug || undefined,
          // Sent only for 'other'. The server clears it otherwise anyway, but
          // sending a stale value would trip the schema's pairing refinement
          // and turn a valid form into a 400.
          facultyOther:
            account.facultySlug === 'other' ? account.facultyOther.trim() || undefined : undefined,
          // Type-specific. Each is omitted on the branch it does not belong
          // to; the server's conditional refinements require the ones that
          // matter, so an omission on the wrong branch is refused there.
          academicStatus: account.academicStatus || undefined,
          studentNumber: account.studentNumber.trim() || undefined,
          department: account.department.trim() || undefined,
          academicTitle: account.academicTitle.trim() || undefined,
          graduationYear: account.graduationYear ? Number(account.graduationYear) : undefined,
          graduationMonth: account.graduationMonth ? Number(account.graduationMonth) : undefined,
          // MENTOR only; the server refuses a schedule on the student branch.
          ...(account.accountType === 'MENTOR'
            ? { availability: cellsToRules(account.availability), timezone: account.timezone }
            : {}),
          locale: document.documentElement.lang || 'az',
          acceptTerms: account.acceptTerms,
          deviceFingerprint: fingerprint,
        }),
      });

      if (res.status === 403) {
        setBlocked({ reference: crypto.randomUUID().slice(0, 8).toUpperCase() });
        return;
      }

      if (res.status === 409) {
        const conflict = await res.json().catch(() => ({}));
        // The server tells us WHICH unique constraint fired, so the user is
        // sent back to the right field rather than a generic "try again".
        // Nickname clashes are named; email/phone clashes share one message
        // (see the comment in the register route for why). Anchor the shared
        // one on the email field, which is the more likely culprit.
        setErrors(
          conflict.error === 'auth.errors.nicknameTaken'
            ? { nickname: 'auth.errors.nicknameTaken' }
            : { email: conflict.error ?? 'auth.errors.credentialsUnavailable' },
        );
        setShowSummary(true);
        setStep('account');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      if (!res.ok) {
        setFormError(res.status === 429 ? 'errors.rateLimited' : 'errors.generic');
        return;
      }

      submittedRef.current = true;

      /**
       * Straight into the product. The account is UNVERIFIED, so the
       * root-layout banner (src/components/account/IdentityPrompt.tsx) is the
       * first thing on the dashboard and stays until verification completes -
       * no query parameter is needed to make it appear.
       *
       * The mentor onboarding card is driven by the viewer's ROLE (see
       * mentorTodo in DashboardShell), not by this redirect, so it keeps
       * working on the second visit too.
       */
      toast.success(t('register.created'));
      router.push('/dashboard');
    } catch {
      // Network failure. The account may or may not exist; the dashboard
      // resolves the true state from the session, and /login is reachable from
      // there, so a generic retry message is the honest thing to show.
      setFormError('errors.generic');
    } finally {
      setSubmitting(false);
    }
  }

  if (blocked) return <BlockedState reference={blocked.reference} />;

  const isLastStep = step === steps[steps.length - 1];

  return (
    <div className="mx-auto w-full max-w-2xl">
      <StepIndicator steps={steps} current={stepIndex} />

      <div className="mt-8">
        {step === 'account' && (
          <StepPanel title={t('auth.register.title')} subtitle={t('auth.register.subtitle')}>
            {showSummary && <ErrorSummary errors={errors} />}
            {/*
              method="post" is a SECURITY control here, not a formality.

              React's onSubmit only exists once this component has hydrated. In
              the window before that - and permanently if the bundle fails to
              load or a hydration mismatch tears the tree down - a Continue
              press or an Enter keystroke falls through to the browser's NATIVE
              submit. A <form> with no method attribute defaults to GET, and a
              native GET serialises every NAMED input into the address bar:

                /register?name=...&username=...&email=...&tel=...&new-password=...

              Those keys are the name= attributes in StepAccount, which is why
              the leak we captured spelled the password field 'new-password'.
              A URL like that is written to browser history, to CDN and proxy
              access logs, to the Referer header of every subsequent request,
              and to any analytics tag on the page - none of which we control
              or can retroactively scrub.

              Declaring method="post" makes that fallback a POST to this same
              route. App Router pages do not handle POST, so it dead-ends in a
              405: the submission fails loudly and, critically, the credentials
              never touch the URL. The hydrated path is unchanged - the handler
              below calls preventDefault() before any of this can apply.
            */}
            <form
              id="account-form"
              // Kept as a real <form> purely for the browser semantics we want:
              // password managers fill the step in one go, and assistive tech
              // announces the fields as one group. It is NOT how we navigate.
              method="post"
              onSubmit={handleAccountSubmit}
              onKeyDown={handleAccountKeyDown}
              noValidate
            >
              <StepAccount
                value={account}
                errors={errors}
                onEmailChange={autoDetect.handleEmailChange}
                onChange={(patch) => {
                  setAccount((prev) => ({ ...prev, ...patch }));
                  setErrors((prev) => {
                    const next = { ...prev };
                    for (const key of Object.keys(patch)) delete next[key as keyof AccountForm];
                    // Drop the summary as soon as the last error is resolved, so
                    // it does not sit there contradicting a now-valid form.
                    if (Object.keys(next).length === 0) setShowSummary(false);
                    return next;
                  });
                }}
              />
            </form>
          </StepPanel>
        )}

        {step === 'type' && (
          <StepPanel
            title={t('auth.register.accountType')}
            subtitle={t('auth.register.accountTypeHint')}
          >
            <StepAccountType
              value={account.accountType}
              error={errors.accountType && t(errors.accountType)}
              onChange={(accountType) => {
                setAccount((prev) => ({
                  ...prev,
                  accountType,
                  /**
                   * Clear the OTHER branch's fields on switch.
                   *
                   * Without this, someone who fills in a student number, goes
                   * back, and becomes a mentor would submit a mentor account
                   * carrying a student number and an academic status - data
                   * the account type says nothing should have, and which the
                   * server would store.
                   */
                  ...(accountType === 'STUDENT'
                    ? { department: '', academicTitle: '', availability: new Set<string>() }
                    : {
                        studentNumber: '',
                        academicStatus: '' as const,
                        graduationYear: '',
                        graduationMonth: '',
                      }),
                }));
                setErrors({});
              }}
            />
          </StepPanel>
        )}

        {step === 'details' && (
          <StepPanel
            title={t('auth.register.detailsTitle')}
            subtitle={
              account.accountType === 'MENTOR'
                ? t('auth.register.detailsMentorHint')
                : t('auth.register.detailsStudentHint')
            }
          >
            {showSummary && <ErrorSummary errors={errors} />}

            <StepDetails
              value={account}
              errors={errors}
              onChange={(patch) => {
                setAccount((prev) => {
                  const next = { ...prev, ...patch };
                  /**
                   * Changing the status invalidates the year, not the month.
                   *
                   * The year list is rebuilt around the new status (past years
                   * for a graduate, future ones for a student), so a year the
                   * old list offered may not exist in the new one - and a
                   * <select> holding a value with no matching <option> renders
                   * BLANK while still reporting that value. Clearing it makes
                   * the control say what it holds: nothing, pick again.
                   */
                  if (patch.academicStatus && patch.academicStatus !== prev.academicStatus) {
                    next.graduationYear = '';
                  }
                  return next;
                });
                setErrors((prev) => {
                  const next = { ...prev };
                  for (const key of Object.keys(patch)) delete next[key as keyof AccountForm];
                  if (patch.academicStatus) delete next.graduationYear;
                  if (Object.keys(next).length === 0) setShowSummary(false);
                  return next;
                });
              }}
            />
          </StepPanel>
        )}

        {step === 'schedule' && (
          <StepPanel
            title={t('auth.register.schedule.title')}
            subtitle={t('auth.register.schedule.subtitle')}
          >
            {showSummary && <ErrorSummary errors={errors} />}

            <StepSchedule
              value={account}
              errors={errors}
              onAvailabilityChange={(action) => {
                setAccount((prev) => ({
                  ...prev,
                  availability: typeof action === 'function' ? action(prev.availability) : action,
                }));
                clearErrors(['availability']);
              }}
              onTimezoneChange={(timezone) => {
                setAccount((prev) => ({ ...prev, timezone }));
                clearErrors(['timezone']);
              }}
            />
          </StepPanel>
        )}

        {/*
          The identity notice, stated once, on the final step whichever that
          is (details for a student, schedule for a mentor).

          It used to be a document-upload step the user was about to hit. Now
          it is a sentence setting the expectation that verification exists
          and is coming - read before the account is created, so nobody is
          surprised by the banner that greets them.
        */}
        {isLastStep && (
          <p className="mt-6 flex items-start gap-2.5 rounded-xl border border-edge bg-surface-muted p-4 text-xs leading-relaxed text-fg-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
            <span className="min-w-0">{t('auth.register.verifyLater')}</span>
          </p>
        )}
      </div>

      {formError && (
        <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
          {t(formError, { max: 5 })}
        </p>
      )}

      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        {stepIndex > 0 ? (
          <button
            type="button"
            onClick={goBack}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-semibold
                       text-fg-muted transition hover:bg-surface-inset hover:text-fg
                       disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('register.back')}
          </button>
        ) : (
          <Link
            href="/login"
            className="min-w-0 text-sm font-medium text-fg-muted transition hover:text-fg"
          >
            {t('auth.register.haveAccount')}{' '}
            <span className="font-semibold text-accent">{t('nav.login')}</span>
          </Link>
        )}

        {isLastStep ? (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="btn-primary h-10 px-5 disabled:cursor-wait"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <UserPlus className="h-4 w-4" aria-hidden="true" />
            )}
            {t('auth.register.createAccount')}
          </button>
        ) : (
          <button
            // ALWAYS type="button". This is the fix for the reload loop.
            //
            // A type="submit" button hands the browser a submission path that
            // exists whether or not React is listening. Any moment JS is not in
            // control - the gap before hydration, a chunk that failed to load, a
            // render error that tore the tree down - the browser services the
            // click itself: full page load, form fields serialised into the URL,
            // back to step 1 with the state lost. That is the reported bug, and
            // no amount of preventDefault() reaches it, because the handler that
            // would call it is precisely what is missing.
            //
            // type="button" removes the path outright.
            type="button"
            onClick={
              step === 'account'
                ? advanceFromAccount
                : step === 'type'
                  ? advanceFromType
                  : advanceFromDetails
            }
            className="btn-primary h-10 px-5"
          >
            {t('register.next')}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function StepIndicator({ steps, current }: { steps: StepId[]; current: number }) {
  const t = useT();

  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {steps.map((id, index) => {
        const done = index < current;
        const active = index === current;

        return (
          <li key={id} className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span
                className={`h-1 rounded-full transition-colors duration-300 ${
                  done ? 'bg-verified' : active ? 'bg-accent' : 'bg-surface-inset'
                }`}
              />
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs
                              font-bold transition-colors ${
                                done
                                  ? 'bg-verified text-white'
                                  : active
                                    ? 'bg-accent text-accent-fg'
                                    : 'bg-surface-inset text-fg-muted'
                              }`}
                >
                  {done ? <Check className="h-2.5 w-2.5" strokeWidth={3.5} /> : index + 1}
                </span>
                <span
                  className={`truncate text-xs font-medium ${active ? 'text-fg' : 'text-fg-muted'}`}
                >
                  {t(`register.steps.${id}`)}
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="animate-rise">
      <h1 className="text-balance text-2xl font-bold tracking-tight text-fg">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{subtitle}</p>
      <div className="mt-7">{children}</div>
    </div>
  );
}

/** Terminal blocked state. No retry affordance, no specifics. */
function BlockedState({ reference }: { reference: string }) {
  const t = useT();

  return (
    <div className="mx-auto max-w-md animate-rise text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-soft">
        <ShieldAlert className="h-7 w-7 text-danger" aria-hidden="true" />
      </div>
      <h1 className="mt-5 text-xl font-bold tracking-tight text-fg">
        {t('register.blocked.title')}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        {t('verification.failure.generic')}
      </p>
      <p className="mt-5 inline-block max-w-full break-anywhere rounded-lg bg-surface-inset px-3 py-2 font-mono text-xs text-fg-muted">
        {t('verification.failure.supportCode', { code: reference })}
      </p>
      <div className="mt-7">
        <Link href="/" className="text-sm font-semibold text-accent transition hover:text-accent">
          CampusHub
        </Link>
      </div>
    </div>
  );
}
