import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { getViewer } from '@/lib/auth/session';
import { MentorApplyForm } from '@/components/mentors/MentorApplyForm';
import { MENTORS_URL } from '@/lib/site';
import {
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALE_COOKIE,
  isLocale,
  translate,
} from '@/lib/i18n/dictionaries';

export const metadata: Metadata = { title: 'Become a mentor' };

export const dynamic = 'force-dynamic';

/**
 * Become a mentor.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PAGE HANDLES SIGNED-OUT VISITORS ITSELF
 * ---------------------------------------------------------------------------
 * This route was listed in the middleware's PROTECTED set, so a signed-out
 * visitor who clicked "Become a mentor" was redirected to /api/auth/refresh and
 * on to /login?next=/mentors/apply. That is a dead end for the exact person the
 * page exists to recruit: they have no account, and /login offers no way to
 * create a mentor one - it only offers registration as a generic signup whose
 * account type they would then have to guess.
 *
 * The guard was also never the security control. Submitting an application is
 * POST /api/mentors/apply, which independently requires a session, an ACTIVE
 * (or RESTRICTED) account and a VERIFIED identity. Removing the middleware
 * entry changes what a guest SEES, not what a guest may DO.
 *
 * So a guest now gets the real call to action - create a mentor account - with
 * the account type already chosen for them, and a sign-in link for the person
 * who simply was not logged in.
 */
export default async function Page() {
  const viewer = await getViewer();

  if (!viewer) {
    // Same resolution the root layout uses: the locale lives in a cookie, not
    // the URL. See src/lib/i18n/dictionaries.ts for that trade-off.
    const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
    const dict = DICTIONARIES[isLocale(raw) ? raw : DEFAULT_LOCALE];
    const t = (key: string) => translate(dict, key);

    return (
      <main id="main" className="min-h-dvh bg-surface-muted">
        <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
          <h1 className="text-xl font-bold tracking-tight text-fg">
            {t('mentors.apply.title')}
          </h1>
          <p className="mt-1 text-sm text-fg-muted">{t('mentors.apply.subtitle')}</p>

          <div className="card mt-5 p-6">
            <h2 className="text-sm font-semibold text-fg">{t('mentors.apply.guest.title')}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
              {t('mentors.apply.guest.body')}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {/* New mentors apply on the mentors site; the main app's
                  registration is for students only. */}
              <a href={MENTORS_URL} className="btn-primary px-4 py-2 text-sm">
                {t('mentors.apply.guest.cta')}
              </a>
              <span className="text-sm text-fg-muted">
                {t('mentors.apply.guest.haveAccount')}{' '}
                <Link
                  href="/login?next=/mentors/apply"
                  className="font-semibold text-accent transition hover:text-accent"
                >
                  {t('mentors.apply.guest.signIn')}
                </Link>
              </span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <MentorApplyForm />
    </main>
  );
}
