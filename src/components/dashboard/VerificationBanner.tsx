'use client';

import { BadgeCheck } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/*
 * The inline dashboard banner that lived here is gone: verification status is
 * reported app-wide by the root-layout banner in
 * src/components/account/IdentityPrompt.tsx, which covers every state short
 * of VERIFIED. Two banners for one state read as a bug.
 */

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
