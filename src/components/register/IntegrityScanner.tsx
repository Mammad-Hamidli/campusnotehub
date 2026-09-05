'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, ScanLine, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

export type ScannerPhase = 'idle' | 'scanning' | 'passed' | 'failed';

const CHECKS = [
  { key: 'checkQuality', delay: 500 },
  { key: 'checkScreen', delay: 1100 },
  { key: 'checkEdit', delay: 1750 },
  { key: 'checkMatch', delay: 2400 },
] as const;

/**
 * Document integrity scanner status panel.
 *
 * IMPORTANT — what this component is and is not.
 *
 * It is a *progress surface* for the real pipeline, and while the API is being
 * wired up it runs on a timer so the flow can be designed and demoed. It is
 * NOT the check itself, and no verification decision should ever be derived
 * from what it displays. The actual analysis lives in
 * services/doc-verifier/app/main.py (moire/FFT recapture detection, ELA and
 * ORB copy-move tampering detection, EXIF inspection, OCR) and the decision in
 * src/lib/verification/policy.ts.
 *
 * The four check labels shown here map 1:1 onto real signal codes so the
 * simulation and production tell the user the same story:
 *
 *   checkQuality -> BLURRY / GLARE / LOW_RESOLUTION / CROPPED_EDGES
 *   checkScreen  -> SCREEN_RECAPTURE
 *   checkEdit    -> DIGITAL_TAMPERING / EDITOR_METADATA / SYNTHETIC_IMAGE
 *   checkMatch   -> NAME_MISMATCH / UNIVERSITY_MISMATCH / PORTRAIT_MISMATCH
 *
 * BACKEND INTEGRATION
 * -------------------
 * Once POST /api/verification/submit returns 202, subscribe to
 * GET /api/verification/events (SSE) and drive `phase` plus `completed` from
 * the server's per-check events instead of the timers below. The server is the
 * only thing that may move this to 'failed'.
 */
export function IntegrityScanner({
  phase,
  readyCount,
  totalCount,
}: {
  phase: ScannerPhase;
  readyCount: number;
  totalCount: number;
}) {
  const t = useT();
  const [completed, setCompleted] = useState<string[]>([]);

  useEffect(() => {
    if (phase !== 'scanning') {
      setCompleted(phase === 'passed' ? CHECKS.map((c) => c.key) : []);
      return;
    }
    setCompleted([]);
    const timers = CHECKS.map((check) =>
      setTimeout(() => setCompleted((prev) => [...prev, check.key]), check.delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [phase]);

  const tone = {
    idle: {
      wrap: 'border-edge bg-surface-muted',
      badge: 'bg-surface-inset text-fg',
      icon: 'text-fg-muted',
    },
    scanning: {
      wrap: 'border-edge bg-accent-soft/70',
      badge: 'bg-accent text-accent-fg',
      icon: 'text-accent',
    },
    passed: {
      wrap: 'border-verified/40 bg-verified-soft',
      badge: 'bg-verified text-white',
      icon: 'text-verified',
    },
    failed: {
      wrap: 'border-danger/40 bg-danger-soft',
      badge: 'bg-danger text-white',
      icon: 'text-danger',
    },
  }[phase];

  return (
    <div className={`rounded-xl border p-4 transition-colors duration-300 ${tone.wrap}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {phase === 'scanning' ? (
            <Loader2 className={`h-[1.15rem] w-[1.15rem] shrink-0 animate-spin ${tone.icon}`} aria-hidden="true" />
          ) : phase === 'passed' ? (
            <ShieldCheck className={`h-[1.15rem] w-[1.15rem] shrink-0 ${tone.icon}`} aria-hidden="true" />
          ) : phase === 'failed' ? (
            <AlertTriangle className={`h-[1.15rem] w-[1.15rem] shrink-0 ${tone.icon}`} aria-hidden="true" />
          ) : (
            <ScanLine className={`h-[1.15rem] w-[1.15rem] shrink-0 ${tone.icon}`} aria-hidden="true" />
          )}
          <p className="min-w-0 text-sm font-semibold leading-snug text-fg">
            {t('register.scanner.title')}
          </p>
        </div>

        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${tone.badge}`}
          // The whole panel is one live region; announcing the badge alone
          // would read the status out of context.
          role="status"
        >
          {t(`register.scanner.${phase}`)}
        </span>
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {CHECKS.map((check) => {
          const done = completed.includes(check.key);
          const active = phase === 'scanning' && !done;

          return (
            <li
              key={check.key}
              className="flex items-center gap-2.5 rounded-lg bg-surface/70 px-3 py-2 text-sm"
            >
              {done ? (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-verified">
                  <Check className="h-2.5 w-2.5 text-accent-fg" strokeWidth={3.5} aria-hidden="true" />
                </span>
              ) : active ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" aria-hidden="true" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded-full border-2 border-edge" aria-hidden="true" />
              )}

              {/* Skeleton shimmer while a check is in flight - the label is
                  still present for screen readers, just visually masked. */}
              <span
                className={`min-w-0 leading-snug transition-colors ${
                  done ? 'text-fg' : 'text-fg-subtle'
                }`}
              >
                {active ? (
                  <span className="relative inline-block overflow-hidden rounded">
                    <span className="opacity-40">{t(`register.scanner.${check.key}`)}</span>
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 -translate-x-full animate-shimmer
 bg-[linear-gradient(90deg,transparent,rgb(var(--surface))_50%,transparent)]"
                    />
                  </span>
                ) : (
                  t(`register.scanner.${check.key}`)
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-3.5 text-xs leading-relaxed text-fg-muted">
        {phase === 'idle'
          ? `${readyCount} / ${totalCount} · ${t('register.scanner.note')}`
          : t('register.scanner.note')}
      </p>
    </div>
  );
}
