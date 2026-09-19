'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle, ArrowRight, Clock, ShieldAlert } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { VERIFICATION_SETTINGS_HREF } from '@/lib/verification/requirements';

/**
 * Every state short of VERIFIED, collapsed into what the user can DO:
 *
 *   UNVERIFIED - nothing submitted yet: call to action.
 *   REJECTED   - the last check failed: call to action, danger tone.
 *   IN_REVIEW  - PROCESSING / NEEDS_REVIEW: the platform owes the user an
 *                answer. Still shown, because verification is not complete,
 *                but as status with no button - there is nothing to press.
 */
export type PromptState = 'UNVERIFIED' | 'REJECTED' | 'IN_REVIEW';

/**
 * Routes where the banner would be noise or an obstruction.
 *
 *   /verify  - redirects to the settings section; painting it would flash.
 *   /logout  - a transient redirect, same reason.
 *   /admin   - staff work a queue; their own verification is handled off-app.
 */
const SILENT_PREFIXES = ['/verify', '/logout', '/admin'];

const TONE: Record<PromptState, { wrap: string; icon: typeof ShieldAlert; iconTone: string }> = {
  UNVERIFIED: { wrap: 'border-warn/30 bg-warn-soft text-warn-fg', icon: ShieldAlert, iconTone: 'text-warn' },
  REJECTED: { wrap: 'border-danger/30 bg-danger-soft text-danger-fg', icon: AlertTriangle, iconTone: 'text-danger' },
  IN_REVIEW: { wrap: 'border-accent/30 bg-accent-soft text-fg', icon: Clock, iconTone: 'text-accent' },
};

const BODY_KEY: Record<PromptState, string> = {
  UNVERIFIED: 'verification.prompt.body',
  REJECTED: 'verification.prompt.rejectedBody',
  IN_REVIEW: 'verification.prompt.reviewBody',
};

/**
 * The persistent "Verify your identity" banner, at the TOP of every page.
 *
 * ---------------------------------------------------------------------------
 * PERSISTENT MEANS NOT DISMISSIBLE
 * ---------------------------------------------------------------------------
 * There is no close button and no collapsed state. The state it reports is
 * real and blocking - an unverified account cannot buy notes, book a mentor,
 * sell or withdraw - so there is no honest version of this that can be put
 * away. A dismissible predecessor produced "why can't I buy notes" tickets
 * from people who clicked the x on day one and never saw it again. It goes
 * away exactly when the account is VERIFIED, because the slot stops
 * rendering it.
 *
 * ---------------------------------------------------------------------------
 * IN FLOW, NOT FIXED
 * ---------------------------------------------------------------------------
 * It is the first child of <body>, above each page's own sticky header, and
 * scrolls away with the page. Pinning it would stack two sticky strips at
 * top:0 (every header already uses it) and permanently cost ~15% of a phone
 * viewport. It is re-read at the top of every page load and navigation, which
 * is what "persistent" needs; the headers still stick normally once it has
 * scrolled past. One line on desktop, two short lines on a phone.
 */
export function IdentityPrompt({ state }: { state: PromptState }) {
  const t = useT();
  const pathname = usePathname();

  if (SILENT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return null;
  }

  const tone = TONE[state];
  const Icon = tone.icon;
  const actionable = state !== 'IN_REVIEW';

  return (
    <div
      // role="status" without aria-live: ambient state, present on every page.
      // A live region would re-announce it on every route change and cut a
      // screen reader off mid-sentence.
      role="status"
      className={`border-b ${tone.wrap}`}
    >
      <div
        className="mx-auto flex max-w-shell flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5
                   sm:flex-nowrap sm:px-6 lg:px-8"
      >
        <Icon className={`h-4 w-4 shrink-0 ${tone.iconTone}`} aria-hidden="true" />

        {/* min-w-0 + flex-1 lets the longer AZ and RU strings wrap instead of
            pushing the button off a 360px screen. */}
        <p className="min-w-0 flex-1 text-sm leading-snug">
          <span className="font-semibold">
            {t(state === 'IN_REVIEW' ? 'verification.prompt.reviewTitle' : 'verification.prompt.title')}
          </span>
          <span className="opacity-90"> — {t(BODY_KEY[state])}</span>
        </p>

        {actionable && (
          <Link
            href={VERIFICATION_SETTINGS_HREF}
            className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs
                        font-semibold text-white transition hover:opacity-90 ${
                          state === 'REJECTED' ? 'bg-danger' : 'bg-warn'
                        }`}
          >
            {t('verification.prompt.cta')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>
    </div>
  );
}
