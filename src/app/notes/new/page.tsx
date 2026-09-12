import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { listUniversities } from '@/lib/firebase/repositories/reference';
import { requirePageSession } from '@/lib/auth/page-guard';
import { can } from '@/lib/permissions';
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
 * re-checks the session and the `notes:sell` capability - this page's redirect
 * is convenience, not the control.
 */
export default async function NewNotePage() {
  // Shared guard rather than a local getViewer()/redirect pair: it also clears
  // a stale access-token cookie on the way out, which a bare redirect to
  // /login cannot do. See src/lib/auth/page-guard.ts.
  const viewer = await requirePageSession('/notes/new');

  /**
   * The verification gate, stated BEFORE the form rather than after the upload.
   *
   * POST /api/notes requires the `notes:sell` capability, which requires a
   * VERIFIED identity (see REQUIRES_VERIFICATION in src/lib/permissions.ts -
   * earning money is gated where spending it is not). That check is the
   * control and it stays exactly where it is.
   *
   * What was wrong was the ORDER the user met it in: this page rendered the
   * full upload form to anyone signed in, so an unverified student chose a
   * file, typed a title, a description and a subject, waited out the upload,
   * and only then received a 403 rendered as a one-line message. The work was
   * lost and nothing said what to do about it - which is why "adding a note
   * does not work" was the reported symptom rather than "I need to verify".
   *
   * Showing the requirement up front costs one capability check and turns a
   * dead end into a link to /verify.
   */
  if (!can(viewer, 'notes:sell')) {
    const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
    const dict = DICTIONARIES[isLocale(raw) ? raw : DEFAULT_LOCALE];
    const t = (key: string) => translate(dict, key);

    return (
      <main id="main" className="min-h-dvh bg-surface-muted">
        <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
          <h1 className="text-xl font-bold tracking-tight text-fg">{t('notes.upload.title')}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t('notes.upload.subtitle')}</p>

          <div className="card mt-5 border-warn/30 bg-warn-soft p-6">
            <h2 className="text-sm font-semibold text-warn-fg">
              {t('notes.upload.verifyFirstTitle')}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-warn-fg">
              {t('notes.upload.verifyFirstBody')}
            </p>
            <Link href="/verify" className="btn-primary mt-4 px-4 py-2 text-sm">
              {t('verification.banner.unverifiedCta')}
            </Link>
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
