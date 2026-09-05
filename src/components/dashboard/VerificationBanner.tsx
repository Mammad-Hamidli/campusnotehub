'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, BadgeCheck, Clock, ShieldAlert, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

export type VerificationState = 'UNVERIFIED' | 'PENDING' | 'NEEDS_REVIEW' | 'REJECTED' | 'VERIFIED';

const CONFIG = {
  UNVERIFIED: {
    key: 'verification.banner.unverified',
    ctaKey: 'verification.banner.unverifiedCta',
    href: '/register',
    icon: ShieldAlert,
    wrap: 'border-warn/40 bg-warn-soft text-warn-fg',
    iconTone: 'text-amber-600',
    cta: 'bg-warn hover:opacity-90',
  },
  PENDING: {
    key: 'verification.banner.pending',
    ctaKey: null,
    href: null,
    icon: Clock,
    // PENDING is styled as information, not warning. The user has done
    // everything asked of them; amber here reads as an accusation.
    wrap: 'border-accent/30 bg-accent-soft text-fg',
    iconTone: 'text-accent',
    cta: '',
  },
  NEEDS_REVIEW: {
    key: 'verification.banner.needsReview',
    ctaKey: null,
    href: null,
    icon: Clock,
    wrap: 'border-accent/30 bg-accent-soft text-fg',
    iconTone: 'text-accent',
    cta: '',
  },
  REJECTED: {
    key: 'verification.banner.rejected',
    ctaKey: 'verification.banner.rejectedCta',
    href: '/register',
    icon: AlertTriangle,
    wrap: 'border-danger/40 bg-danger-soft text-danger-fg',
    iconTone: 'text-danger',
    cta: 'bg-danger hover:opacity-90',
  },
} as const;

/**
 * The persistent account-status strip.
 *
 * Design decisions worth preserving through any restyle:
 *
 *  - Inline at the top of the content column, not a fixed overlay. A fixed
 *    banner permanently eats ~15% of a phone viewport and users learn to
 *    ignore it within a day; inline means it scrolls away and gets re-read
 *    every time they return to the top.
 *  - Dismissible for the session, never permanently. The state it describes is
 *    real and blocking, and hiding it forever generates "why can't I sell
 *    notes" support tickets.
 *  - role="status", not role="alert". This is ambient state; an alert would
 *    interrupt a screen reader mid-sentence on every single page load.
 *  - Colour is never the only signal — each state has its own icon and text.
 */
export function VerificationBanner({
  state,
  remainingAttempts = 2,
}: {
  state: VerificationState;
  remainingAttempts?: number;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);

  if (state === 'VERIFIED' || dismissed) return null;

  const config = CONFIG[state];
  const Icon = config.icon;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`animate-rise mb-5 flex flex-col gap-3 rounded-xl border px-4 py-3.5
                  sm:flex-row sm:items-center sm:justify-between ${config.wrap}`}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={`mt-0.5 h-[1.15rem] w-[1.15rem] shrink-0 ${config.iconTone}`} aria-hidden="true" />
        {/* min-w-0 lets the longer AZ and RU strings wrap rather than forcing
            the flex row to overflow on a 360px screen. */}
        <p className="min-w-0 text-sm font-medium leading-relaxed">
          {t(config.key, { remaining: remainingAttempts })}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
        {config.ctaKey && config.href && (
          <Link
            href={config.href}
            className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-accent-fg transition ${config.cta}`}
          >
            {t(config.ctaKey)}
          </Link>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t('common.close')}
          className="rounded-lg p-1.5 opacity-60 transition hover:bg-black/5 hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** Inline status chip used next to a display name. */
export function VerifiedBadge({ verified }: { verified: boolean }) {
  const t = useT();

  if (!verified) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5
 text-2xs font-medium text-fg-muted"
      >
        {t('verification.badge.unverified')}
      </span>
    );
  }

  return (
    <BadgeCheck
      className="h-4 w-4 shrink-0 text-verified"
      aria-label={t('a11y.verifiedBadge')}
    />
  );
}
