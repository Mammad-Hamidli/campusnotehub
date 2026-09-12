'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Clock, Loader2, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { DocumentDropzone, type DocKind, type DocState } from './DocumentDropzone';
import { IntegrityScanner, type ScannerPhase } from './IntegrityScanner';
import { ZeroRetentionNotice } from './ZeroRetentionNotice';
import { EMPTY_DOCUMENTS, slotsFor, type DocumentMap } from './types';

type Me = { role: string; verificationStatus: string };

/** Statuses from which the account may (re)submit - mirrors the submit route's guards. */
const CAN_SUBMIT = new Set(['UNVERIFIED', 'REJECTED', 'PROCESSING']);

const STATUS_KEY: Record<string, string> = {
  VERIFIED: 'verification.badge.verified',
  NEEDS_REVIEW: 'verification.banner.needsReview',
};

/**
 * Document submission for a signed-in account.
 *
 * The same slots, dropzones, integrity scanner and endpoint as the last step
 * of registration, without the account steps: the account already exists, so
 * this only ever calls POST /api/verification/submit.
 */
export function VerifyDocuments() {
  const t = useT();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [documents, setDocuments] = useState<DocumentMap>(EMPTY_DOCUMENTS);
  const [scanner, setScanner] = useState<ScannerPhase>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadFailed(false);
    try {
      const res = await fetch('/api/me', { signal, cache: 'no-store' });
      if (res.status === 401) {
        window.location.replace(`/logout?next=${encodeURIComponent('/login?next=/verify')}`);
        return;
      }
      if (!res.ok) throw new Error(`GET /api/me ${res.status}`);
      const { user } = await res.json();
      setMe({ role: user.role, verificationStatus: user.verificationStatus });
    } catch {
      if (!signal?.aborted) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Teachers and mentors prove identity only; everyone else also proves
  // enrolment - the split requiredKindsFor() applies on the server from the
  // stored role.
  const slots = useMemo(
    () => slotsFor(me?.role === 'TEACHER' || me?.role === 'MENTOR' ? 'TEACHER' : 'STUDENT'),
    [me?.role],
  );
  const readyCount = slots.filter(({ kind }) => documents[kind].phase === 'ready').length;
  const allReady = readyCount === slots.length;

  const handleChange = useCallback((kind: DocKind, next: DocState) => {
    setDocuments((prev) => ({ ...prev, [kind]: next }));
    setFormError(null);
  }, []);

  async function submit() {
    if (submitting || !allReady) return;
    setSubmitting(true);
    setFormError(null);
    setScanner('scanning');

    try {
      const form = new FormData();
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
      router.push(`/dashboard?verification=${String(payload.status ?? 'NEEDS_REVIEW')}`);
    } catch {
      setScanner('failed');
      setFormError('errors.generic');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadFailed) {
    return (
      <Shell title={t('verification.title')} subtitle="">
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
          {t('errors.generic')}
        </p>
        <button type="button" onClick={() => void load()} className="btn-primary mt-4 h-10 px-5">
          {t('common.retry')}
        </button>
      </Shell>
    );
  }

  if (!me) {
    return (
      <div className="flex justify-center py-20 text-fg-muted" aria-busy="true">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    );
  }

  if (!CAN_SUBMIT.has(me.verificationStatus)) {
    const key = STATUS_KEY[me.verificationStatus] ?? 'verification.banner.needsReview';
    return (
      <Shell title={t('verification.title')} subtitle="">
        <div role="status" className="flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3.5 text-sm text-fg">
          {me.verificationStatus === 'VERIFIED' ? (
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden="true" />
          ) : (
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          )}
          <span>{t(key)}</span>
        </div>
        <Link href="/dashboard" className="btn-primary mt-5 inline-flex h-10 items-center px-5">
          {t('admin.nav.dashboard')}
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title={t('verification.title')} subtitle={t('verification.subtitle')}>
      <ZeroRetentionNotice />

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {slots.map(({ kind, labelKey }) => (
          <DocumentDropzone
            key={kind}
            kind={kind}
            labelKey={labelKey}
            state={documents[kind]}
            onChange={handleChange}
          />
        ))}
      </div>

      <ul className="mt-5 grid gap-2 rounded-xl bg-surface p-4 sm:grid-cols-2">
        {(['flat', 'light', 'corners', 'noEdit'] as const).map((tip) => (
          <li key={tip} className="flex items-start gap-2 text-xs text-fg-muted">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
            <span className="min-w-0 leading-snug">{t(`verification.tips.${tip}`)}</span>
          </li>
        ))}
      </ul>

      {scanner !== 'idle' && (
        <div className="mt-5">
          <IntegrityScanner phase={scanner} readyCount={readyCount} totalCount={slots.length} />
        </div>
      )}

      {formError && (
        <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
          {t(formError, { max: 5 })}
        </p>
      )}

      <div className="mt-7 flex items-center justify-between gap-3">
        <Link href="/dashboard" className="text-sm font-medium text-fg-muted transition hover:text-fg">
          {t('admin.nav.dashboard')}
        </Link>
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
          {submitting ? t('register.scanner.scanning') : t('register.finish')}
        </button>
      </div>

      {!allReady && (
        <p aria-live="polite" className="mt-3 text-right text-xs text-fg-muted">
          {readyCount} / {slots.length}
        </p>
      )}
    </Shell>
  );
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="animate-rise mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight text-fg">{title}</h1>
      {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{subtitle}</p>}
      <div className="mt-7">{children}</div>
    </div>
  );
}
