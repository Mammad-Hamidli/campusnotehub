import type { Metadata } from 'next';
import { requirePageSession } from '@/lib/auth/page-guard';
import { UserSearchResults } from '@/components/search/UserSearchResults';

export const metadata: Metadata = {
  title: 'Search',
  robots: { index: false, follow: false },
};

/** Signed-in only, like the API behind it; never prerendered. */
export const dynamic = 'force-dynamic';

/** All usernames matching `?q=` - the dashboard search's "View all results". */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  await requirePageSession(`/search${q ? `?q=${encodeURIComponent(q)}` : ''}`);

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <UserSearchResults initialQuery={typeof q === 'string' ? q.slice(0, 25) : ''} />
    </main>
  );
}
