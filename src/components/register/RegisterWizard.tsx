'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileCheck2,
  Loader2,
  Lock,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { DocumentDropzone, type DocKind, type DocState } from './DocumentDropzone';
import { IntegrityScanner, type ScannerPhase } from './IntegrityScanner';
import { StepAccount, UNIVERSITIES } from './StepAccount';
import { StepAccountType } from './StepAccountType';
import { StepDetails } from './StepDetails';
import { ErrorSummary } from './ErrorSummary';
import { ZeroRetentionNotice } from './ZeroRetentionNotice';
import { useUniversityAutoDetect } from './useUniversityAutoDetect';
import {
  DOCUMENT_SLOTS,
  slotsFor,
  EMPTY_ACCOUNT,
  EMPTY_DOCUMENTS,
  collectFingerprint,
  validateAccount,
  type AccountForm,
  type DocumentMap,
  type FieldErrors,
} from './types';

/**
 * Five steps, not three.
 *
 *   account   - name, date of birth, credentials (common to both types)
 *   type      - Student or Teacher/Mentor
 *   details   - the fields that depend on that choice
 *   documents - the documents that depend on that choice
 *   review    - confirm and submit
 *
 * The type choice sits between the common information and everything
 * type-specific so a person is never asked for a student number before the
 * product knows they are a student.
 */
type StepId = 'account' | 'type' | 'details' | 'documents' | 'review';
const STEPS: StepId[] = ['account', 'type', 'details', 'documents', 'review'];

export function RegisterWizard() {
  const t = useT();
  const router = useRouter();

  const [step, setStep] = useState<StepId>('account');
  const [account, setAccount] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [documents, setDocuments] = useState<DocumentMap>(EMPTY_DOCUMENTS);
  const [scanner, setScanner] = useState<ScannerPhase>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | undefined>();
  const [blocked, setBlocked] = useState<{ reference: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  // Set once POST /api/auth/register has succeeded; see submit().
  const registeredRef = useRef(false);

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
   * the user could not reach by clicking.
   */
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('type')?.toUpperCase();
    if (requested === 'STUDENT' || requested === 'TEACHER' || requested === 'MENTOR') {
      setAccount((prev) => ({ ...prev, accountType: requested }));
    }
  }, []);

  /**
   * Documents live in browser memory until submit - there is no intermediate
   * upload any more. A refresh therefore loses them, so warn before unload
   * once the user has actually picked something.
   */
  /**
   * The slots this registration actually has to fill.
   *
   * A teacher has no student card, so requiring one would make their
   * registration impossible to finish. requiredKindsFor() applies the same
   * split on the server, from the account's own role.
   */
  const activeSlots = useMemo(() => slotsFor(account.accountType), [account.accountType]);

  const hasPickedDocuments = useMemo(
    () => activeSlots.some(({ kind }) => documents[kind].phase === 'ready'),
    [documents, activeSlots],
  );

  useEffect(() => {
    if (!hasPickedDocuments || submitting) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasPickedDocuments, submitting]);

  const stepIndex = STEPS.indexOf(step);

  const readyDocs = useMemo(
    () => activeSlots.filter(({ kind }) => documents[kind].phase === 'ready').length,
    [documents, activeSlots],
  );
  const allDocsReady = readyDocs === activeSlots.length;

  const handleDocChange = useCallback((kind: DocKind, next: DocState) => {
    setDocuments((prev) => ({ ...prev, [kind]: next }));
    setFormError(null);
  }, []);

  /**
   * THE NAVIGATION FIX.
   *
   * The old version validated, stored errors, and returned. Two of those
   * errors (the consent checkboxes) had no visible representation, so a user
   * who had not ticked them pressed Continue and saw absolutely nothing
   * happen. The button read as broken; the state machine was working fine.
   *
   * Three changes:
   *  1. failures now render through <ErrorSummary/>, which takes focus;
   *  2. the transition is unconditional once validation passes, and the
   *     summary is cleared so a stale one cannot linger on step two;
   *  3. the documents step reports what is still missing instead of silently
   *     refusing to advance.
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
   * Step 3 -> Step 4.
   *
   * Runs the FULL validator rather than a details-only subset: it already
   * branches on accountType, and re-running it here means a value that became
   * invalid because the type changed - a graduation date on a teacher, say -
   * is caught before the document upload rather than at submit.
   */
  function advanceFromDetails() {
    const found = validateAccount(account);
    setErrors(found);

    const hasErrors = Object.keys(found).length > 0;
    setShowSummary(hasErrors);
    if (hasErrors) return;

    setShowSummary(false);
    setFormError(null);
    setStep('documents');
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

  /** Step 2 -> Step 3. Documents are picked, not typed, so no form here. */
  function goToReview() {
    if (!allDocsReady) {
      setFormError('verification.errors.allFourRequired');
      return;
    }
    setFormError(null);
    setStep('review');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goBack() {
    setStep(STEPS[Math.max(0, stepIndex - 1)]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Submit: two requests, in order.
   *
   *   1. POST /api/auth/register        JSON  -> 201, session cookies set
   *   2. POST /api/verification/submit  multipart -> 200 with the verdict
   *
   * Step 2 is where the important change lives. It used to return 202 and hand
   * off to a background queue; now it runs the whole pipeline inline and comes
   * back with a real outcome in 3-8 seconds, because under zero retention the
   * documents cannot be parked anywhere while a worker gets to them. The
   * scanner panel shows genuine progress for that window rather than a
   * simulated one.
   *
   * The two calls stay separate so a failure during the (much larger) document
   * upload does not lose the account the user just created.
   */
  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    setScanner('scanning');

    try {
      /**
       * Register only once per wizard session.
       *
       * If the account was created on an earlier press and only the document
       * step failed, the session cookie is already set - so a retry goes
       * straight to the documents. Re-POSTing registration would be refused
       * as a duplicate (409, bouncing the user back to step 1) AND would spend
       * a token from the per-address auth:register budget, which is how a
       * couple of document retries turned into a 429.
       */
      if (!registeredRef.current) {
        const registerRes = await fetch('/api/auth/register', {
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
            universityId: account.universityId,
            facultySlug: account.facultySlug || undefined,
            // Sent only for 'other'. The server clears it otherwise anyway, but
            // sending a stale value would trip the schema's pairing refinement
            // and turn a valid form into a 400.
            facultyOther:
              account.facultySlug === 'other' ? account.facultyOther.trim() || undefined : undefined,
            // Type-specific. Each is omitted on the branch it does not belong
            // to; the server's conditional refinements require the ones that
            // matter, so an omission on the wrong branch is refused there.
            studentNumber: account.studentNumber.trim() || undefined,
            department: account.department.trim() || undefined,
            academicTitle: account.academicTitle.trim() || undefined,
            graduationYear: account.graduationYear ? Number(account.graduationYear) : undefined,
            graduationMonth: account.graduationMonth ? Number(account.graduationMonth) : undefined,
            locale: document.documentElement.lang || 'az',
            acceptTerms: account.acceptTerms,
            consentDocumentProcessing: account.consentDocuments,
            deviceFingerprint: fingerprint,
          }),
        });

        if (registerRes.status === 403) {
          setBlocked({ reference: crypto.randomUUID().slice(0, 8).toUpperCase() });
          return;
        }
        if (registerRes.status === 409) {
          setScanner('idle');
          const conflict = await registerRes.json().catch(() => ({}));
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
        if (!registerRes.ok) {
          setScanner('idle');
          setFormError(registerRes.status === 429 ? 'errors.rateLimited' : 'errors.generic');
          return;
        }
        registeredRef.current = true;
      }

      // Multipart: the four files themselves, not references to uploads.
      const form = new FormData();
      // Only the slots this account type must fill. Sending a teacher's
      // absent student-card fields would fail the multipart parse on a
      // document the server never asked for.
      for (const { kind } of activeSlots) {
        const doc = documents[kind];
        if (doc.phase === 'ready') form.append(kind, doc.file, `${kind}.jpg`);
      }

      const verifyRes = await fetch('/api/verification/submit', {
        method: 'POST',
        body: form, // no content-type header - the browser sets the boundary
      });

      if (verifyRes.status === 403) {
        setBlocked({ reference: crypto.randomUUID().slice(0, 8).toUpperCase() });
        return;
      }

      const payload = await verifyRes.json().catch(() => ({}));

      if (!verifyRes.ok) {
        setScanner('failed');
        setFormError(payload.error ?? 'errors.generic');
        setStep('documents');
        return;
      }

      setScanner('passed');

      // The account exists and is usable regardless of the verdict, so route
      // to the dashboard either way. The banner reflects the real status.
      //
      // A mentor carries `next=mentor`, which makes the dashboard surface the
      // remaining step - the mentor profile a moderator has to approve before
      // the account is listed in the directory. The dashboard is still the
      // landing page rather than /mentors/apply directly, so a new mentor sees
      // their verification state first and understands why they are not
      // bookable yet.
      const status = String(payload.status ?? 'NEEDS_REVIEW');
      const next = account.accountType === 'MENTOR' ? '&next=mentor' : '';
      router.push(`/dashboard?verification=${status}&welcome=1${next}`);
    } catch {
      // Network failure after the account may already exist. The dashboard
      // resolves the true state from the session, so send them there.
      setScanner('idle');
      router.push('/dashboard');
    } finally {
      setSubmitting(false);
    }
  }

  if (blocked) return <BlockedState reference={blocked.reference} />;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <StepIndicator current={stepIndex} />

      <div className="mt-8">
        {step === 'account' && (
          <StepPanel title={t('auth.register.title')} subtitle={t('auth.register.subtitle')}>
            {showSummary && <ErrorSummary errors={errors} />}
            {/* The id no longer wires up a submit - the footer button drives the
                step change through onClick. It is kept because the label/aria
                associations and the error summary's focus targets reference it. */}
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
              //
              // method="post" is the last-resort guarantee. Nothing should ever
              // reach a native submit now that Continue is type="button", but if
              // one is ever reintroduced this makes the fallback a POST rather
              // than a GET that writes the password into the address bar.
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
                   * back, and becomes a teacher would submit a teacher account
                   * carrying a student number - data the account type says
                   * nothing should have, and which the server would store.
                   */
                  ...(accountType === 'STUDENT'
                    ? { department: '', academicTitle: '' }
                    : { studentNumber: '', graduationYear: '', graduationMonth: '' }),
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
                : account.accountType === 'TEACHER'
                  ? t('auth.register.detailsTeacherHint')
                  : t('auth.register.detailsStudentHint')
            }
          >
            <StepDetails
              value={account}
              errors={errors}
              onChange={(patch) => {
                setAccount((prev) => ({ ...prev, ...patch }));
                setErrors((prev) => {
                  const next = { ...prev };
                  for (const key of Object.keys(patch)) delete next[key as keyof AccountForm];
                  if (Object.keys(next).length === 0) setShowSummary(false);
                  return next;
                });
              }}
            />
          </StepPanel>
        )}

        {step === 'documents' && (
          <StepPanel title={t('verification.title')} subtitle={t('verification.subtitle')}>
            {/* Above the slots, not below: the reassurance has to land before
                the user is asked to photograph their ID, not after. */}
            <ZeroRetentionNotice />

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {activeSlots.map(({ kind, labelKey }) => (
                <DocumentDropzone
                  key={kind}
                  kind={kind}
                  labelKey={labelKey}
                  state={documents[kind]}
                  onChange={handleDocChange}
                />
              ))}
            </div>

            <ul className="mt-5 grid gap-2 rounded-xl bg-surface-muted p-4 sm:grid-cols-2">
              {(['flat', 'light', 'corners', 'noEdit'] as const).map((tip) => (
                <li key={tip} className="flex items-start gap-2 text-xs text-fg-muted">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
                  <span className="min-w-0 leading-snug">{t(`verification.tips.${tip}`)}</span>
                </li>
              ))}
            </ul>
          </StepPanel>
        )}

        {step === 'review' && (
          <StepPanel title={t('register.review.title')} subtitle={t('register.review.body')}>
            <ReviewSummary
              account={account}
              documents={documents}
              onEdit={(target) => setStep(target)}
            />

            {/* The scanner lives on the review step now, because that is when
                the analysis actually runs. Showing it on the upload step meant
                animating a process that had not started. */}
            {scanner !== 'idle' && (
              <div className="mt-5">
                <IntegrityScanner phase={scanner} readyCount={readyDocs} totalCount={activeSlots.length} />
              </div>
            )}
          </StepPanel>
        )}
      </div>

      {formError && (
        <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
          {t(formError, { max: 5 })}
        </p>
      )}

      <div className="mt-7 flex items-center justify-between gap-3">
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
            className="text-sm font-medium text-fg-muted transition hover:text-fg"
          >
            {t('auth.register.haveAccount')}{' '}
            <span className="font-semibold text-accent">{t('nav.login')}</span>
          </Link>
        )}

        {step === 'review' ? (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="btn-primary h-10 px-5 disabled:cursor-wait"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            )}
            {submitting ? t('register.scanner.scanning') : t('register.finish')}
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
            // type="button" removes the path outright. The browser has nothing
            // to do with this click; if JS is not ready the button is inert, and
            // inert is recoverable - a reload that discards the form is not.
            type="button"
            onClick={
              step === 'account'
                ? advanceFromAccount
                : step === 'type'
                  ? advanceFromType
                  : step === 'details'
                    ? advanceFromDetails
                    : goToReview
            }
            className="btn-primary h-10 px-5"
          >
            {t('register.next')}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* A disabled button with no explanation is the most common dead end in
          upload flows. Always say what is missing. */}
      {step === 'documents' && !allDocsReady && (
        <p aria-live="polite" className="mt-3 text-right text-xs text-fg-muted">
          {readyDocs} / {activeSlots.length}
        </p>
      )}
    </div>
  );
}

function StepIndicator({ current }: { current: number }) {
  const t = useT();

  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {STEPS.map((id, index) => {
        const done = index < current;
        const active = index === current;

        return (
          <li key={id} className="flex flex-1 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span
                className={`h-1 rounded-full transition-colors duration-300 ${
                  done ? 'bg-verified' : active ? 'bg-accent' : 'bg-surface-inset'
                }`}
              />
              <span className="flex items-center gap-1.5">
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
                  className={`truncate text-xs font-medium ${
                    active ? 'text-fg' : 'text-fg-muted'
                  }`}
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
      <h1 className="text-2xl font-bold tracking-tight text-fg">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{subtitle}</p>
      <div className="mt-7">{children}</div>
    </div>
  );
}

function ReviewSummary({
  account,
  documents,
  onEdit,
}: {
  account: AccountForm;
  documents: DocumentMap;
  onEdit: (step: StepId) => void;
}) {
  const t = useT();
  const university = UNIVERSITIES.find((u) => u.id === account.universityId);

  const isStudent = account.accountType === 'STUDENT';

  const rows = [
    {
      label: t('auth.register.accountType'),
      value: t(
        account.accountType === 'MENTOR'
          ? 'auth.register.types.mentor.title'
          : account.accountType === 'TEACHER'
            ? 'auth.register.types.teacher.title'
            : 'auth.register.types.student.title',
      ),
    },
    { label: t('auth.register.fullName'), value: `${account.firstName} ${account.lastName}`.trim() },
    { label: t('auth.register.dateOfBirth'), value: account.dateOfBirth },
    { label: t('auth.register.email'), value: account.email },
    ...(account.phone ? [{ label: t('auth.register.phone'), value: account.phone }] : []),
    {
      label: t('auth.register.university'),
      value: university ? `${university.id} — ${university.az}` : '—',
    },
    /**
     * Graduation is a STUDENT claim only. Listing it for a teacher or a mentor
     * rendered "00 / " from the empty fields their branch never collects - a
     * summary contradicting the form directly above it.
     */
    ...(isStudent
      ? [
          {
            label: t('auth.register.graduationYear'),
            value: `${account.graduationMonth.padStart(2, '0')} / ${account.graduationYear}`,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-xl border border-edge">
        <header className="flex items-center justify-between gap-3 border-b border-edge bg-surface-muted px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">{t('register.steps.account')}</h2>
          <button
            type="button"
            onClick={() => onEdit('account')}
            className="text-xs font-semibold text-accent transition hover:text-accent"
          >
            {t('register.review.edit')}
          </button>
        </header>
        <dl className="divide-y divide-edge">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
              <dt className="w-full shrink-0 text-xs text-fg-muted sm:w-44">{row.label}</dt>
              <dd className="min-w-0 break-words text-sm font-medium text-fg">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="overflow-hidden rounded-xl border border-edge">
        <header className="flex items-center justify-between gap-3 border-b border-edge bg-surface-muted px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">{t('register.review.documents')}</h2>
          <button
            type="button"
            onClick={() => onEdit('documents')}
            className="text-xs font-semibold text-accent transition hover:text-accent"
          >
            {t('register.review.edit')}
          </button>
        </header>
        <ul className="grid gap-3 p-4 sm:grid-cols-2">
          {slotsFor(account.accountType).map(({ kind, labelKey }) => {
            const doc = documents[kind];
            return (
              <li key={kind} className="flex items-center gap-3 rounded-lg bg-surface-muted p-2.5">
                <span className="h-11 w-16 shrink-0 overflow-hidden rounded-md bg-surface-inset">
                  {'previewUrl' in doc && doc.previewUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={doc.previewUrl} alt="" className="h-full w-full object-cover" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg">
                    {t(labelKey)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-2xs text-verified-fg">
                    <FileCheck2 className="h-3 w-3" aria-hidden="true" />
                    {t('verification.upload.ready')}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="flex items-start gap-2 rounded-xl bg-accent-soft p-4 text-xs leading-relaxed text-accent">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0">{t('register.retention.lead')}</span>
      </p>
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
      <p className="mt-5 inline-block rounded-lg bg-surface-inset px-3 py-2 font-mono text-xs text-fg-muted">
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
