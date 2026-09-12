import type { Metadata } from 'next';
import { StubPage } from '@/components/ui/UnderConstruction';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = { title: 'Bookmarks' };

/** Session state is per-request; this page must never be prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * Stub route. Returns 200 with an honest "not built yet" state.
 *
 * Every link in the navigation resolves to a real page, so a 404 in the logs
 * is always a genuine bug rather than a known gap. See
 * src/components/ui/UnderConstruction.tsx for the reasoning.
 */
export default async function Page() {
  await requirePageSession('/bookmarks');

  return <StubPage titleKey="nav.bookmarks" />;
}
