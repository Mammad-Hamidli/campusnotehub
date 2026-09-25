import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { listUniversities } from '@/lib/firebase/repositories/reference';
import { requirePageSession } from '@/lib/auth/page-guard';
import { can, denialKey } from '@/lib/permissions';
import { NoteUploadForm } from '@/components/notes/NoteUploadForm';
import {
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALE_COOKIE,
  isLocale,
  translate,
} from '@/lib/i18n/dictionaries';

export const metadata: Metadata = {
  title: 'Upload note',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * The university list is loaded server-side because it is reference data every
 * visitor may see. The upload itself is authorized in POST /api/notes, which
 * re-checks the session and the `notes:share` capability - this page's redirect
 * is convenience, not the control.
 */
export default async function NewNotePage() {
  // Shared guard rather than a local getViewer()/redirect pair: it also clears
  // a stale access-token cookie on the way out, which a bare redirect to
  // /login cannot do. See src/lib/auth/page-guard.ts.
  const viewer = await requirePageSession('/notes/new');

  /**
   * The capability gate, stated BEFORE the form rather than after the upload.
   *
   * POST /api/notes requires `notes:share`, which every active, finished
   * account holds - notes are free and sharing one needs no verification. What
   * still refuses it is an unfinished quick-login profile or a suspended
   * account, and the reason (denialKey) is shown up front so nobody fills in
   * the form and uploads a file only to meet a 403.
   */
  if (!can(viewer, 'notes:share')) {
    const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
    const dict = DICTIONARIES[isLocale(raw) ? raw : DEFAULT_LOCALE];
    const t = (key: string) => translate(dict, key);

    return (
      <main id="main" className="min-h-dvh bg-surface-muted">
        <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
          <h1 className="text-xl font-bold tracking-tight text-fg">{t('notes.upload.title')}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t('notes.upload.subtitle')}</p>

          <div className="card mt-5 border-warn/30 bg-warn-soft p-6">
            <h2 className="text-sm font-semibold text-warn-fg">{t('notes.upload.blockedTitle')}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-warn-fg">{t(denialKey(viewer, 'notes:share'))}</p>
            {viewer?.profileIncomplete && (
              <Link href="/onboarding" className="btn-primary mt-4 px-4 py-2 text-sm">
                {t('onboarding.banner.cta')}
              </Link>
            )}
          </div>
        </div>
      </main>
    );
  }

  const universities = (await listUniversities()).map((u) => ({ id: u.id, code: u.code }));

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <NoteUploadForm universities={universities} />
    </main>
  );
}
