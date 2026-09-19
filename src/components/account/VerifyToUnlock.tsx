'use client';

import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { VERIFICATION_SETTINGS_HREF } from '@/lib/verification/requirements';

/** The key denialKey() in src/lib/permissions.ts returns for "verify first". */
export const VERIFICATION_REQUIRED_KEY = 'verification.restricted.action';

/**
 * Inline refusal for a gated action (buy, top up), with the way out attached.
 * A bare "you can't do this" next to a Buy button is a dead end; the same
 * sentence with a link to the verification section is a next step.
 */
export function VerifyToUnlock({ className = '' }: { className?: string }) {
  const t = useT();
  return (
    <p role="alert" className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-warn-fg ${className}`}>
      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
      <span className="min-w-0">{t(VERIFICATION_REQUIRED_KEY)}</span>
      <Link href={VERIFICATION_SETTINGS_HREF} className="font-semibold underline underline-offset-2">
        {t('verification.prompt.cta')}
      </Link>
    </p>
  );
}
