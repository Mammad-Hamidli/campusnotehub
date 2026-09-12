'use client';

import Link from 'next/link';
import { LogOut, Languages, Palette } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { PageHeader } from './AdminShell';

/**
 * The administrator's own settings.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 * There is no platform-configuration section here, because there is no
 * platform-configuration model in the schema to back one. Rendering a form of
 * toggles that write nowhere would be worse than not having the page - it
 * would look like configuration while changing nothing, and the first person
 * to trust it would be misled.
 *
 * So this page covers exactly what genuinely exists per-operator: appearance,
 * language, and ending the session. Privacy fields and the notification matrix
 * live on the student-facing /settings screen and are not duplicated here;
 * this links across rather than maintaining a second copy of that form.
 *
 * Sign-out points at /logout, which revokes the session ROW server-side rather
 * than only clearing cookies - see the note in that route for why that
 * distinction is what makes the back button safe.
 */
export function AdminSettings({ nickname }: { nickname: string }) {
  const t = useT();

  return (
    <>
      <PageHeader title={t('admin.settings.title')} description={t('admin.settings.subtitle')} />

      <div className="grid max-w-2xl gap-4">
        <section className="card p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Palette className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
            {t('admin.settings.appearance')}
          </h2>
          <p className="mt-1 text-xs text-fg-muted">{t('settings.theme.description')}</p>
          <div className="mt-3">
            <ThemeToggle />
          </div>
        </section>

        <section className="card p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Languages className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
            {t('admin.settings.language')}
          </h2>
          <div className="mt-3">
            <LanguageToggle />
          </div>
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold text-fg">{t('settings.privacy.title')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {t('settings.privacy.description')}
          </p>
          {/* Links across instead of duplicating the privacy form. Two copies
              of a visibility matrix is two places for it to drift out of step
              with what the profile serialiser actually enforces. */}
          <Link href="/settings" className="btn-secondary mt-3 px-3 py-1.5 text-sm">
            {t('nav.settings')}
          </Link>
        </section>

        <section className="card border-danger/25 p-4">
          <h2 className="text-sm font-semibold text-fg">{t('admin.settings.dangerZone')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {t('admin.settings.sessionsHint')}
          </p>
          <p className="mt-2 text-xs text-fg-subtle">
            {t('admin.profile.signedInAs')} <span className="font-medium text-fg">@{nickname}</span>
          </p>
          {/* prefetch={false}: /logout revokes the session, and a prefetch would
              fire it on scroll rather than on click. See MenuItem in ui/Menu.tsx. */}
          <Link href="/logout" prefetch={false} className="btn-danger mt-3 px-3 py-1.5 text-sm">
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            {t('admin.settings.signOutAll')}
          </Link>
        </section>
      </div>
    </>
  );
}
