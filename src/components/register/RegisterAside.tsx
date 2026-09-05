'use client';

import { Lock, ShieldCheck, UserCheck, Wallet } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useT } from '@/lib/i18n/LocaleProvider';

const REASONS = [
  { key: 'b1', icon: ShieldCheck },
  { key: 'b2', icon: UserCheck },
  { key: 'b3', icon: Wallet },
] as const;

/**
 * The left column of the registration screen.
 *
 * Rebuilt: it was a slate-950 panel with two overlapping radial indigo/violet
 * washes - the most decorative element in the whole product, sitting next to
 * the most sensitive form in it. Now it is the page canvas with a single
 * dividing border, which reads as considered rather than marketed-at.
 *
 * The content stays, because it earns its place: asking a 19-year-old to
 * photograph their national ID is a big ask and the reasons have to be visible
 * on the same screen as the request. Burying "why we need this" behind a
 * tooltip is how you get a 40% drop-off at step two.
 */
export function RegisterAside() {
  const t = useT();

  return (
    <aside className="flex flex-col justify-between border-edge px-4 py-5 lg:w-[22rem] lg:shrink-0 lg:border-r lg:px-8 lg:py-8">
      <div className="flex items-center justify-between gap-4">
        <Logo />
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>

      {/* Hidden on mobile: on a 360px screen this would push the form below
          the fold, and the form is what the user came for. The one essential
          line (the privacy note) is repeated on the review step. */}
      <div className="mt-12 hidden lg:block">
        <h2 className="text-md font-medium leading-snug text-fg">{t('register.aside.title')}</h2>

        <ul className="mt-5 space-y-4">
          {REASONS.map(({ key, icon: Icon }) => (
            <li key={key} className="flex items-start gap-3">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              <p className="min-w-0 text-sm leading-relaxed text-fg-muted">
                {t(`register.aside.${key}`)}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-8 flex items-start gap-2.5 rounded-lg border border-edge bg-surface-muted p-3 lg:mt-0">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
        <span className="min-w-0 text-xs leading-relaxed text-fg-muted">
          {t('register.aside.privacy')}
        </span>
      </p>
    </aside>
  );
}
