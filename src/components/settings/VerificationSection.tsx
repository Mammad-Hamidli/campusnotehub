'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  Check,
  Clock,
  IdCard,
  Loader2,
  Lock,
  School,
  ShieldCheck,
} from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { DocumentDropzone, type DocKind, type DocState } from '@/components/register/DocumentDropzone';
import { IntegrityScanner, type ScannerPhase } from '@/components/register/IntegrityScanner';
import { ZeroRetentionNotice } from '@/components/register/ZeroRetentionNotice';
import { EMPTY_DOCUMENTS, slotsFor, type DocumentMap } from '@/components/register/types';
import { requirementReasonFor } from '@/lib/verification/requirements';

export type IdentityState = {
  role: string;
  verificationStatus: string;
  verifiedAt: string | null;
};

/** Statuses from which the account may (re)submit - mirrors the submit route's guards. */
const CAN_SUBMIT = new Set(['UNVERIFIED', 'REJECTED']);
const IN_REVIEW = new Set(['PROCESSING', 'NEEDS_REVIEW']);

/** What verification unlocks - the REQUIRES_VERIFICATION set in src/lib/permissions.ts, in words. */
const UNLOCKS = ['buy', 'topup', 'sell', 'book', 'withdraw'] as const;

/**
 * Settings -> Verification. THE place identity documents are submitted.
 *
 * Four states, one per thing the user can be told:
 *
 *   UNVERIFIED / REJECTED  - the upload form, asking for exactly the documents
 *                            this account needs (see below).
 *   PROCESSING / NEEDS_REVIEW - "we have your documents", no action.
 *   VERIFIED               - the green status, and what it unlocked.
 *
 * ---------------------------------------------------------------------------
 * WHICH DOCUMENTS
 * ---------------------------------------------------------------------------
 * Decided by requiredKindsFor() in src/lib/verification/requirements.ts from
 * the STORED role, the same function POST /api/verification/submit enforces:
 *
 *   Student, currently studying (STUDENT)  - national ID + student ID
 *   Student, graduated (ALUMNI)            - national ID only
 *   Mentor (MENTOR, TEACHER)               - national ID only
 *
 * The reason is stated above the slots, so a mentor who sees two slots where
 * a friend saw four knows why instead of wondering what failed to load.
 */
export function VerificationSection({
  identity,
  loadFailed,
  onStatusChange,
}: {
  identity: IdentityState | null;
  loadFailed: boolean;
  onStatusChange: (status: string) => void;
}) {
  const t = useT();

  if (loadFailed) {
    return (
      <p role="alert" className="card p-6 text-sm text-danger-fg">
        {t('errors.generic')}
      </p>
    );
  }
  if (!identity) {
    return <div className="card h-72 animate-pulse" aria-busy="true" />;
  }

  const status = identity.verificationStatus;

  return (
    <section className="card p-6" aria-labelledby="verification-heading">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="verification-heading" className="text-md font-medium tracking-tight text-fg">
            {t('settings.verification.title')}
          </h2>
          <p className="mt-1 text-xs text-fg-muted">{t('settings.verification.description')}</p>
        </div>
        <StatusPill status={status} />
      </div>

      {status === 'VERIFIED' ? (
        <VerifiedState verifiedAt={identity.verifiedAt} />
      ) : IN_REVIEW.has(status) ? (
        <InReviewState />
      ) : CAN_SUBMIT.has(status) ? (
        <UploadForm role={identity.role} rejected={status === 'REJECTED'} onStatusChange={onStatusChange} />
      ) : (
        // BANNED, or a status this screen does not know: nothing to offer.
        <p className="rounded-lg bg-surface-muted px-3 py-2.5 text-sm text-fg-muted">
          {t('verification.failure.generic')}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: string }) {
  const t = useT();

  const config =
    status === 'VERIFIED'
      ? { key: 'settings.verification.status.verified', icon: BadgeCheck, tone: 'bg-verified text-white' }
      : IN_REVIEW.has(status)
        ? { key: 'settings.verification.status.inReview', icon: Clock, tone: 'bg-accent-soft text-accent' }
        : status === 'REJECTED'
          ? { key: 'settings.verification.status.rejected', icon: AlertTriangle, tone: 'bg-danger-soft text-danger-fg' }
          : { key: 'settings.verification.status.unverified', icon: AlertCircle, tone: 'bg-warn-soft text-warn-fg' };
  const Icon = config.icon;

  // Colour is never the only signal: every state has its own icon and word.
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${config.tone}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {t(config.key)}
    </span>
  );
}

function VerifiedState({ verifiedAt }: { verifiedAt: string | null }) {
  const t = useT();
  const { locale } = useLocale();

  const date = useMemo(() => {
    if (!verifiedAt) return null;
    const parsed = new Date(verifiedAt);
    return Number.isNaN(parsed.getTime())
      ? null
      : new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(parsed);
  }, [verifiedAt, locale]);

  return (
    <div className="rounded-xl border border-verified/30 bg-verified-soft p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-verified text-white">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg">{t('settings.verification.verifiedTitle')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
            {date ? t('settings.verification.verifiedOn', { date }) : t('settings.verification.verifiedBody')}
          </p>
        </div>
      </div>

      <UnlockList unlocked />
    </div>
  );
}

function InReviewState() {
  const t = useT();
  return (
    <div className="flex items-start gap-3 rounded-xl border border-accent/30 bg-accent-soft p-5">
      <Clock className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-fg">{t('verification.prompt.reviewTitle')}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{t('verification.banner.needsReview')}</p>
      </div>
    </div>
  );
}

/** The capabilities verification gates, shown locked before and ticked after. */
function UnlockList({ unlocked }: { unlocked: boolean }) {
  const t = useT();
  const Icon = unlocked ? Check : Lock;

  return (
    <div className={unlocked ? 'mt-4 border-t border-verified/20 pt-4' : ''}>
      <p className="text-xs font-medium text-fg">
        {t(unlocked ? 'settings.verification.unlockedTitle' : 'settings.verification.unlocksTitle')}
      </p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {UNLOCKS.map((key) => (
          <li key={key} className="flex items-center gap-2 text-xs text-fg-muted">
            <Icon
              className={`h-3.5 w-3.5 shrink-0 ${unlocked ? 'text-verified' : 'text-fg-subtle'}`}
              aria-hidden="true"
            />
            <span className="min-w-0">{t(`settings.verification.unlocks.${key}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Requirements({ role }: { role: string }) {
  const t = useT();
  const reason = requirementReasonFor(role);
  const needsStudentId = reason === 'STUDYING';

  const items = [
    { icon: IdCard, key: 'settings.verification.need.nationalId' },
    ...(needsStudentId ? [{ icon: School, key: 'settings.verification.need.studentId' }] : []),
  ];

  return (
    <div className="rounded-xl border border-edge bg-surface-muted p-4">
      <p className="text-sm font-medium text-fg">{t('settings.verification.needTitle')}</p>
      <ul className="mt-2.5 space-y-2">
        {items.map(({ icon: Icon, key }) => (
          <li key={key} className="flex items-center gap-2.5 text-sm text-fg">
            <Icon className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0">{t(key)}</span>
          </li>
        ))}
      </ul>
      {/* Why this set, in terms of what the user told us at signup. */}
      <p className="mt-3 text-xs leading-relaxed text-fg-muted">
        {t(`settings.verification.reason.${reason.toLowerCase()}`)}
      </p>
    </div>
  );
}

function UploadForm({
  role,
  rejected,
  onStatusChange,
}: {
  role: string;
  rejected: boolean;
  onStatusChange: (status: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentMap>(EMPTY_DOCUMENTS);
  const [scanner, setScanner] = useState<ScannerPhase>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // From the STORED role; the server re-derives the same set and refuses a
  // submission that is short of it.
  const slots = useMemo(() => slotsFor(role), [role]);
  const readyCount = slots.filter(({ kind }) => documents[kind].phase === 'ready').length;
  const allReady = readyCount === slots.length;

  const handleChange = useCallback((kind: DocKind, next: DocState) => {
    setDocuments((prev) => ({ ...prev, [kind]: next }));
    setFormError(null);
  }, []);

  /**
   * The photos were taken one at a time with a phone camera; losing them to
   * an accidental reload is a real cost, so warn once something is in hand.
   */
  useEffect(() => {
    if (readyCount === 0 || submitting) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [readyCount, submitting]);

  async function submit() {
    if (submitting || !allReady) return;

    // Checked before anything is sent, mirroring the server: consent is the
    // precondition for processing, not a box collected alongside it.
    if (!consent) {
      setConsentError(true);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setScanner('scanning');

    try {
      const form = new FormData();
      form.append('consentDocumentProcessing', 'true');
      for (const { kind } of slots) {
        const doc = documents[kind];
        if (doc.phase === 'ready') form.append(kind, doc.file, `${kind}.jpg`);
      }

      const res = await fetch('/api/verification/submit', { method: 'POST', body: form });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        setScanner('failed');
        setFormError(payload.error ?? 'errors.generic');
        return;
      }

      setScanner('passed');
      toast.success(t('verification.submitted.body'), { title: t('verification.submitted.title') });
      onStatusChange(String(payload.status ?? 'NEEDS_REVIEW'));
      // Re-render the server components, so the root-layout banner moves to
      // "in review" (or disappears, on an instant approval) without a reload.
      router.refresh();
    } catch {
      setScanner('failed');
      setFormError('errors.generic');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {rejected && (
        <p role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0">{t('verification.prompt.rejectedBody')}</span>
        </p>
      )}

      <Requirements role={role} />
      <UnlockList unlocked={false} />
      <ZeroRetentionNotice />

      <div className="grid gap-4 sm:grid-cols-2">
        {slots.map(({ kind, labelKey }) => (
          <DocumentDropzone key={kind} kind={kind} labelKey={labelKey} state={documents[kind]} onChange={handleChange} />
        ))}
      </div>

      <ul className="grid gap-2 rounded-xl bg-surface-muted p-4 sm:grid-cols-2">
        {(['flat', 'light', 'corners', 'noEdit'] as const).map((tip) => (
          <li key={tip} className="flex items-start gap-2 text-xs text-fg-muted">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
            <span className="min-w-0 leading-snug">{t(`verification.tips.${tip}`)}</span>
          </li>
        ))}
      </ul>

      {/*
        The document-processing consent, asked at the point of processing:
        specific and informed, next to the documents it covers and the
        zero-retention notice above. POST /api/verification/submit refuses
        without it; this is the UI half of a rule the server owns.
      */}
      <div className="rounded-xl border border-edge bg-surface-muted p-4">
        <label htmlFor="doc-consent" className="flex cursor-pointer items-start gap-2.5">
          <input
            id="doc-consent"
            type="checkbox"
            checked={consent}
            required
            aria-required="true"
            aria-invalid={consentError}
            aria-describedby={consentError ? 'doc-consent-error' : undefined}
            onChange={(e) => {
              setConsent(e.target.checked);
              if (e.target.checked) setConsentError(false);
            }}
            className={`mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-2 bg-surface text-accent
                        transition-colors focus:ring-accent ${consentError ? 'border-danger' : 'border-edge-strong'}`}
          />
          <span className="min-w-0 text-xs leading-relaxed text-fg-muted">{t('auth.register.dataConsent')}</span>
        </label>
        {consentError && (
          <p id="doc-consent-error" role="alert" className="ml-6.5 mt-1.5 flex items-start gap-1.5 text-xs text-danger">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t('auth.errors.consentRequired')}</span>
          </p>
        )}
      </div>

      {scanner !== 'idle' && <IntegrityScanner phase={scanner} readyCount={readyCount} totalCount={slots.length} />}

      {formError && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
          {t(formError, { max: 5 })}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {!allReady && (
          <p aria-live="polite" className="text-xs tabular text-fg-muted">
            {readyCount} / {slots.length}
          </p>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !allReady}
          className="btn-primary h-10 px-5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? t('register.scanner.scanning') : t('verification.submit')}
        </button>
      </div>
    </div>
  );
}
