import type { Metadata } from 'next';
import { ReviewsConsole, type ReviewTab } from '@/components/admin/ReviewsConsole';
import { getAdminViewer } from '@/lib/auth/admin';

export const metadata: Metadata = {
  title: 'Reviews',
  robots: { index: false, follow: false },
};

const TABS: ReviewTab[] = ['mentors', 'notes', 'deletions'];

/**
 * The tier decides whether the deletion queue is offered at all - a UI
 * courtesy only, since GET /api/admin/deletion-requests enforces ADMIN itself.
 * getAdminViewer shares the layout's memoised session read.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const [viewer, { tab }] = await Promise.all([getAdminViewer(), searchParams]);
  return (
    <ReviewsConsole
      canReviewDeletions={viewer?.role === 'ADMIN'}
      initialTab={TABS.includes(tab as ReviewTab) ? (tab as ReviewTab) : 'mentors'}
    />
  );
}
