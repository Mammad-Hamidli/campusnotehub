import type { Metadata } from 'next';
import { requirePageSession } from '@/lib/auth/page-guard';
import { MentorScheduleSettings } from '@/components/mentors/MentorScheduleSettings';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, DICTIONARIES, LOCALE_COOKIE, isLocale, translate } from '@/lib/i18n/dictionaries';

export const metadata: Metadata = { title: 'Mentor schedule', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/** Mentor availability settings. The API scopes every read/write to the session's own profile. */
export default async function MentorSchedulePage() {
  await requirePageSession('/mentors/schedule');
  const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
  const dict = DICTIONARIES[isLocale(raw) ? raw : DEFAULT_LOCALE];

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <h1 className="text-xl font-bold tracking-tight text-fg">{translate(dict, 'mentors.schedule.title')}</h1>
        <p className="mb-5 mt-1 text-sm text-fg-muted">{translate(dict, 'mentors.schedule.subtitle')}</p>
        <MentorScheduleSettings />
      </div>
    </main>
  );
}
